// Prüft den laufenden Server von außen: Anmeldung, Wörter, Verlauf, Fortschritt, Live und Anwesenheit.
// Start:  npm run dev   (in einem Terminal)   und dann   npm run smoke
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CODE = process.env.CODE || 'wupa';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FEHLT ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const tag = Math.random().toString(36).slice(2, 6);

const bad = await call('POST', '/api/join', null, { code: 'falsch', name: 'Nope', pin: '1234' });
ok(bad.status === 403 && bad.body.error === 'wrong_code', 'falscher Clubcode wird abgelehnt');
const a = await call('POST', '/api/join', null, { code: CODE.toUpperCase(), name: 'Alex' + tag, pin: '4711' });
const b = await call('POST', '/api/join', null, { code: CODE, name: 'Nika' + tag, pin: '0815' });
ok(a.status === 200 && /^[a-f0-9]{64}$/.test(a.body.token) && /^u_/.test(a.body.user.id), 'Anmeldung klappt (Groß/Kleinschreibung egal)');
const A = a.body.token, B = b.body.token;
const again = await call('POST', '/api/join', null, { code: CODE, name: 'alex' + tag, pin: '4711' });
ok(again.body.user.id === a.body.user.id, 'gleicher Name auf zweitem Gerät ergibt dieselbe Person');
const wp = await call('POST', '/api/join', null, { code: CODE, name: 'Alex' + tag, pin: '9999' });
ok(wp.status === 403 && wp.body.error === 'wrong_pin', 'falscher PIN: Name kann nicht übernommen werden');
const sp = await call('POST', '/api/join', null, { code: CODE, name: 'Neu' + tag, pin: '12' });
ok(sp.status === 400 && sp.body.error === 'bad_pin', 'zu kurzer PIN wird abgelehnt');
let locked = 0;
for (let i = 0; i < 6; i++) { const r = await call('POST', '/api/join', null, { code: CODE, name: 'Nika' + tag, pin: 'nope' + i }); if (r.status === 429) locked++; }
ok(locked >= 1, 'nach mehreren falschen PINs wird der Name kurz gesperrt');
ok((await call('GET', '/api/col/words')).status === 401, 'ohne Token kein Zugriff');
ok((await call('GET', '/api/me', 'f'.repeat(64))).status === 401, 'falscher Token wird abgelehnt');

const words = await call('GET', '/api/col/words', A);
ok(words.body.docs.length >= 51 && words.body.docs.some((d) => d.id === 'b0' && d.data.codes[0] === 'Wazo'), 'Startwörter sind da (' + words.body.docs.length + ')');

const wid = 'c' + tag;
const put = await call('PUT', '/api/doc/words/' + wid, A, { world: 'eigen', de: 'Tschüss', codes: ['Tschu', 'Ciao'], by: a.body.user.id, n: Date.now() });
ok(put.status === 200 && put.body.doc.by === a.body.user.id, 'Wort anlegen');
ok((await call('PUT', '/api/doc/words/' + wid + 'x', A, { de: '', codes: [] })).status === 400, 'leeres Wort wird abgelehnt');
ok((await call('PUT', '/api/doc/words/Zzz', A, { de: 'x', codes: ['y'] })).status === 400, 'ID muss mit b oder c beginnen');
const upd = await call('PATCH', '/api/doc/words/' + wid, B, { de: 'Tschüss!' });
ok(upd.status === 200 && upd.body.doc.de === 'Tschüss!' && upd.body.doc.codes.length === 2, 'zweite Person korrigiert das Wort');
ok((await call('PATCH', '/api/doc/words/c' + tag + 'nope', A, { de: 'x' })).status === 404, 'Korrigieren eines fehlenden Worts gibt 404');
const big = await call('PUT', '/api/doc/words/c' + tag + 'big', A, { de: 'x'.repeat(20000), codes: ['y'] });
ok(big.status === 413, 'zu große Anfrage wird abgelehnt');
const xss = await call('PUT', '/api/doc/words/c' + tag + 'z', A, { world: 'unbekannt', de: '<b>Hi</b>\u0000', codes: ['a'.repeat(100)] });
ok(xss.status === 200 && xss.body.doc.world === 'eigen' && xss.body.doc.codes[0].length === 40 && !xss.body.doc.de.includes('\u0000'), 'Eingaben werden bereinigt');

const hid = 'h' + tag;
const h = await call('PUT', '/api/doc/history/' + hid, A, { act: 'add', wid, before: null, after: { world: 'eigen', de: 'Tschüss', codes: ['Tschu'] }, by: 'u_fake' });
ok(h.status === 200 && h.body.doc.by === a.body.user.id, 'Verlauf: Autor wird vom Server gesetzt, nicht vom Client');
ok((await call('PATCH', '/api/doc/history/' + hid, B, { undone: true })).body.doc.undone === true, 'Verlauf: rückgängig markieren');
ok((await call('DELETE', '/api/doc/history/' + hid, A)).status === 403, 'Verlauf lässt sich nicht löschen');

const pr = await call('PUT', '/api/progress', A, { state: { xp: 123, stats: { b0: { c: 2, w: 0 } } } });
const pg = await call('GET', '/api/progress', A);
const pg2 = await call('GET', '/api/progress', B);
ok(pr.status === 200 && pg.body.state.xp === 123 && pg2.body.state === null, 'Fortschritt ist privat pro Person');

// Live: zwei Verbindungen, Anwesenheit und Wort-Änderungen
function open(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/api/live');
    const st = { ws, msgs: [], ready: null };
    ws.onmessage = (e) => { if (e.data === 'pong') { st.pong = true; return; } const m = JSON.parse(e.data); st.msgs.push(m); if (m.t === 'ready') { st.ready = m; resolve(st); } };
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token }));
    ws.onerror = reject;
  });
}
const wa = await open(A), wb = await open(B);
wa.ws.send(JSON.stringify({ t: 'presence', presence: { act: 'knobelt am Code-Quiz', lv: 3 } }));
await sleep(300);
const lastPeers = wb.msgs.filter((m) => m.t === 'peers').pop();
const alexPeer = lastPeers && lastPeers.peers.find((p) => p.by === a.body.user.id);
ok(lastPeers && lastPeers.peers.length >= 2 && alexPeer && alexPeer.presence.act === 'knobelt am Code-Quiz' && alexPeer.presence.lv === 3, 'Freunde online: Nika sieht Alex mit Aktivität');
wb.ws.send('ping'); await sleep(150);
ok(wb.pong === true, 'Ping wird beantwortet');
wa.ws.send(JSON.stringify({ t: 'presence', presence: { act: 'x'.repeat(500), lv: 99999 } })); await sleep(200);
const clipped = wb.msgs.filter((m) => m.t === 'peers').pop().peers.find((p) => p.by === a.body.user.id);
ok(clipped.presence.act.length === 60 && clipped.presence.lv === 999, 'Anwesenheit wird begrenzt');
await call('PATCH', '/api/doc/words/' + wid, B, { de: 'Servus' });
await sleep(250);
ok(wa.msgs.some((m) => m.t === 'doc' && m.id === wid && m.data.de === 'Servus'), 'Wort-Änderung kommt live bei der anderen Person an');
await call('DELETE', '/api/doc/words/' + wid, A);
await sleep(250);
ok(wb.msgs.some((m) => m.t === 'doc' && m.id === wid && m.op === 'delete'), 'Löschen kommt live an');
wa.ws.close(); await sleep(300);
const afterLeave = wb.msgs.filter((m) => m.t === 'peers').pop();
ok(!afterLeave.peers.some((p) => p.by === a.body.user.id), 'Wer die Seite schließt, verschwindet aus der Liste');
const unauth = await new Promise((resolve) => {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/api/live');
  ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: 'e'.repeat(64) }));
  ws.onclose = (e) => resolve(e.code);
  setTimeout(() => resolve(-1), 3000);
});
ok(unauth === 4401, 'WebSocket mit falschem Token wird getrennt');
wb.ws.close();
console.log(fails ? `\n${fails} Prüfung(en) fehlgeschlagen` : '\nAlles in Ordnung');
process.exit(fails ? 1 : 0);
