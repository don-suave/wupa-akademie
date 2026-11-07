// Wupa Akademie: Cloudflare Worker + eine Durable Object ("Club") mit SQLite.
// Die Durable Object hält Wörter, Verlauf, Fortschritt, Mitglieder und alle
// offenen WebSocket-Verbindungen (Live-Updates und "Freunde online").
import { DurableObject } from 'cloudflare:workers';
import { SEED } from './seed.js';

const WORLD_IDS = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'eigen'];
const ID_RULES = { words: /^[bc][a-z0-9]{0,30}$/, history: /^[A-Za-z0-9_-]{1,40}$/ };
const MAX_BODY = 8 * 1024;
const MAX_PROGRESS = 32 * 1024;
const MAX_WORDS = 3000;
const MAX_USERS = 60;
const KEEP_HISTORY = 200;
const MAX_SOCKETS = 200;

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: HEADERS });

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function sameHash(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function cleanStr(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, max);
}
function hexBytes(hex) { return Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16)); }
async function hashPin(pin, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexBytes(saltHex), iterations: 100000 }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
function cleanWord(x) {
  if (!isObj(x)) return null;
  const de = cleanStr(x.de, 80);
  const codes = (Array.isArray(x.codes) ? x.codes : []).slice(0, 8).map((c) => cleanStr(c, 40)).filter(Boolean);
  if (!de || !codes.length) return null;
  return {
    world: WORLD_IDS.includes(x.world) ? x.world : 'eigen',
    de,
    codes,
    by: typeof x.by === 'string' && /^u_[a-z0-9]{6,32}$/.test(x.by) ? x.by : null,
    n: Number.isFinite(x.n) ? x.n : 0,
  };
}
const pub = (u) => ({ id: u.id, name: u.name, color: u.color });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const stub = env.CLUB.get(env.CLUB.idFromName('main'));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

export class Club extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.joinHits = new Map();
    this.pinFails = new Map();
    ctx.blockConcurrencyWhile(async () => this.init());
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  init() {
    const q = (s, ...p) => this.sql.exec(s, ...p);
    q(`CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT UNIQUE NOT NULL,
      color INTEGER NOT NULL, created INTEGER NOT NULL,
      pin_salt TEXT NOT NULL DEFAULT '', pin_hash TEXT NOT NULL DEFAULT '')`);
    q(`CREATE TABLE IF NOT EXISTS tokens(
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL, epoch TEXT NOT NULL DEFAULT '')`);
    q(`CREATE TABLE IF NOT EXISTS docs(
      coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL,
      PRIMARY KEY (coll, id))`);
    q(`CREATE TABLE IF NOT EXISTS progress(
      user_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)`);
    q(`CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    const seeded = q(`SELECT v FROM meta WHERE k='seeded'`).toArray()[0];
    if (!seeded) {
      const now = Date.now();
      for (const w of SEED) {
        const data = { world: w.world, de: w.de, codes: w.codes, by: null, n: w.n };
        q(`INSERT OR IGNORE INTO docs(coll,id,data,updated) VALUES('words',?,?,?)`, w.id, JSON.stringify(data), now);
      }
      q(`INSERT INTO meta(k,v) VALUES('seeded','1')`);
    }
  }

  // ---------- HTTP ----------
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (path === '/api/live') return await this.live(request);
      if (path === '/api/join' && method === 'POST') return await this.join(request);

      const user = await this.authenticate(request.headers.get('authorization'));
      if (!user) throw new HttpError(401, 'unauthorized');

      if (path === '/api/me' && method === 'GET') return json({ user: pub(user) });
      if (path === '/api/users' && method === 'GET') return json({ users: this.users() });
      if (path === '/api/progress') return await this.progress(request, user);

      let m = path.match(/^\/api\/col\/(words|history)$/);
      if (m && method === 'GET') return json({ docs: this.list(m[1]) });

      m = path.match(/^\/api\/doc\/(words|history)\/([A-Za-z0-9_-]{1,40})$/);
      if (m) return await this.doc(request, user, m[1], m[2]);

      throw new HttpError(404, 'not_found');
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code }, e.status);
      console.error(e);
      return json({ error: 'server_error' }, 500);
    }
  }

  async readJson(request, max = MAX_BODY) {
    const text = await request.text();
    if (text.length > max) throw new HttpError(413, 'too_large');
    try { return JSON.parse(text); } catch { throw new HttpError(400, 'bad_json'); }
  }

  async authenticate(header) {
    const m = /^Bearer ([a-f0-9]{64})$/.exec(header || '');
    if (!m) return null;
    const hash = await sha256(m[1]);
    const row = this.sql.exec(
      `SELECT u.id, u.name, u.color FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.hash = ? AND t.epoch = ?`,
      hash, String(this.env.CLUB_EPOCH || ''),
    ).toArray()[0];
    return row || null;
  }

  users() {
    return this.sql.exec(`SELECT id, name, color FROM users ORDER BY created`).toArray();
  }

  async join(request) {
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    const now = Date.now();
    const hits = (this.joinHits.get(ip) || []).filter((t) => now - t < 60_000);
    if (hits.length >= 10) throw new HttpError(429, 'rate_limited');
    hits.push(now);
    this.joinHits.set(ip, hits);

    const body = await this.readJson(request);
    const secret = this.env.CLUB_CODE;
    if (!secret) throw new HttpError(500, 'not_configured');
    const given = cleanStr(body && body.code, 80).toLowerCase();
    const ok = sameHash(await sha256(given), await sha256(String(secret).trim().toLowerCase()));
    if (!ok) throw new HttpError(403, 'wrong_code');

    const name = cleanStr(body && body.name, 24);
    if (!name) throw new HttpError(400, 'bad_name');
    const key = name.toLowerCase();

    const pin = cleanStr(body && body.pin, 32);
    if (pin.length < 4) throw new HttpError(400, 'bad_pin');

    let user = this.sql.exec(`SELECT id, name, color, pin_salt, pin_hash FROM users WHERE name_key = ?`, key).toArray()[0];
    let created = false;
    if (user) {
      const fails = (this.pinFails.get(key) || []).filter((t) => now - t < 600_000);
      if (fails.length >= 5) throw new HttpError(429, 'rate_limited');
      if (!sameHash(await hashPin(pin, user.pin_salt), user.pin_hash)) {
        fails.push(now);
        this.pinFails.set(key, fails);
        throw new HttpError(403, 'wrong_pin');
      }
      this.pinFails.delete(key);
    } else {
      const count = this.sql.exec(`SELECT COUNT(*) AS c FROM users`).one().c;
      if (count >= MAX_USERS) throw new HttpError(403, 'club_full');
      const salt = randomHex(16);
      user = { id: 'u_' + randomHex(8), name, color: Math.floor(Math.random() * 360) };
      this.sql.exec(`INSERT INTO users(id,name,name_key,color,created,pin_salt,pin_hash) VALUES(?,?,?,?,?,?,?)`,
        user.id, user.name, key, user.color, now, salt, await hashPin(pin, salt));
      created = true;
    }
    const token = randomHex(32);
    this.sql.exec(`INSERT INTO tokens(hash,user_id,created,epoch) VALUES(?,?,?,?)`,
      await sha256(token), user.id, now, String(this.env.CLUB_EPOCH || ''));
    this.sql.exec(
      `DELETE FROM tokens WHERE user_id = ? AND hash NOT IN
       (SELECT hash FROM tokens WHERE user_id = ? ORDER BY created DESC LIMIT 10)`, user.id, user.id);
    if (created) this.broadcast({ t: 'users', users: this.users() });
    return json({ token, user: pub(user) });
  }

  list(coll) {
    if (coll === 'history') {
      return this.sql.exec(
        `SELECT id, data FROM docs WHERE coll='history' ORDER BY updated DESC LIMIT 100`,
      ).toArray().map((r) => ({ id: r.id, data: JSON.parse(r.data) }));
    }
    return this.sql.exec(`SELECT id, data FROM docs WHERE coll=?`, coll)
      .toArray().map((r) => ({ id: r.id, data: JSON.parse(r.data) }));
  }

  async doc(request, user, coll, id) {
    if (!ID_RULES[coll].test(id)) throw new HttpError(400, 'bad_id');
    const method = request.method;
    const row = this.sql.exec(`SELECT data FROM docs WHERE coll=? AND id=?`, coll, id).toArray()[0];

    if (method === 'DELETE') {
      if (coll === 'history') throw new HttpError(403, 'forbidden');
      if (row) {
        this.sql.exec(`DELETE FROM docs WHERE coll=? AND id=?`, coll, id);
        this.broadcast({ t: 'doc', coll, id, op: 'delete' });
      }
      return json({ ok: true });
    }
    if (method !== 'PUT' && method !== 'PATCH') throw new HttpError(405, 'method_not_allowed');

    const body = await this.readJson(request);
    let next;
    if (coll === 'words') {
      let merged = body;
      if (method === 'PATCH') {
        if (!row) throw new HttpError(404, 'not_found');
        merged = { ...JSON.parse(row.data), ...(isObj(body) ? body : {}) };
      }
      next = cleanWord(merged);
      if (!next) throw new HttpError(400, 'bad_word');
      if (!row) {
        const count = this.sql.exec(`SELECT COUNT(*) AS c FROM docs WHERE coll='words'`).one().c;
        if (count >= MAX_WORDS) throw new HttpError(507, 'quota_exceeded');
      }
    } else if (method === 'PATCH') {
      if (!row) throw new HttpError(404, 'not_found');
      next = { ...JSON.parse(row.data), undone: isObj(body) && body.undone === true };
    } else {
      if (row) throw new HttpError(409, 'exists');
      const act = isObj(body) && ['add', 'edit', 'del'].includes(body.act) ? body.act : null;
      if (!act) throw new HttpError(400, 'bad_history');
      next = {
        act,
        wid: cleanStr(body.wid, 40),
        before: cleanWord(body.before),
        after: cleanWord(body.after),
        by: user.id,
        ts: Date.now(),
        undone: false,
      };
    }
    this.sql.exec(
      `INSERT INTO docs(coll,id,data,updated) VALUES(?,?,?,?)
       ON CONFLICT(coll,id) DO UPDATE SET data=excluded.data, updated=excluded.updated`,
      coll, id, JSON.stringify(next), Date.now());
    if (coll === 'history') {
      this.sql.exec(
        `DELETE FROM docs WHERE coll='history' AND id NOT IN
         (SELECT id FROM docs WHERE coll='history' ORDER BY updated DESC LIMIT ?)`, KEEP_HISTORY);
    }
    this.broadcast({ t: 'doc', coll, id, op: 'set', data: next });
    return json({ doc: next });
  }

  async progress(request, user) {
    if (request.method === 'GET') {
      const row = this.sql.exec(`SELECT data FROM progress WHERE user_id=?`, user.id).toArray()[0];
      return json({ state: row ? JSON.parse(row.data) : null });
    }
    if (request.method === 'PUT') {
      const body = await this.readJson(request, MAX_PROGRESS);
      if (!isObj(body) || !isObj(body.state)) throw new HttpError(400, 'bad_progress');
      this.sql.exec(
        `INSERT INTO progress(user_id,data,updated) VALUES(?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated=excluded.updated`,
        user.id, JSON.stringify(body.state), Date.now());
      return json({ ok: true });
    }
    throw new HttpError(405, 'method_not_allowed');
  }

  // ---------- WebSocket: Live-Updates und Anwesenheit ----------
  async live(request) {
    if (request.headers.get('upgrade') !== 'websocket') throw new HttpError(426, 'upgrade_required');
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) throw new HttpError(503, 'busy');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ uid: null, peer: null, presence: {}, at: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > 4096) return;
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (!isObj(msg)) return;
    const att = ws.deserializeAttachment() || {};

    if (msg.t === 'auth') {
      const user = await this.authenticate('Bearer ' + String(msg.token || ''));
      if (!user) { ws.close(4401, 'unauthorized'); return; }
      const next = { uid: user.id, peer: randomHex(6), presence: {}, at: Date.now() };
      ws.serializeAttachment(next);
      ws.send(JSON.stringify({ t: 'ready', peer: next.peer, me: pub(user), users: this.users() }));
      this.broadcastPeers();
      return;
    }
    if (!att.uid) return;
    if (msg.t === 'presence' && isObj(msg.presence)) {
      const p = msg.presence;
      att.presence = {
        act: cleanStr(p.act, 60),
        lv: Number.isFinite(p.lv) ? Math.max(0, Math.min(999, Math.floor(p.lv))) : 0,
      };
      att.at = Date.now();
      ws.serializeAttachment(att);
      this.broadcastPeers();
    }
  }

  webSocketClose(ws) {
    try { ws.close(1000, 'bye'); } catch { /* schon zu */ }
    this.broadcastPeers(ws);
  }
  webSocketError(ws) { this.broadcastPeers(ws); }

  peers(exclude) {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const a = ws.deserializeAttachment();
      if (a && a.uid) out.push({ peer: a.peer, by: a.uid, presence: a.presence, updatedAt: a.at });
    }
    return out;
  }
  broadcastPeers(exclude) { this.broadcast({ t: 'peers', peers: this.peers(exclude) }, exclude); }
  broadcast(obj, exclude) {
    const text = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const a = ws.deserializeAttachment();
      if (!a || !a.uid) continue;
      try { ws.send(text); } catch { /* Verbindung weg */ }
    }
  }
}
