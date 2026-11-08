/* Wupa Akademie: Anbindung an den Cloudflare-Server.
   Die App spricht dieselbe Schnittstelle wie in Claude (window.claude.use). Diese Datei stellt
   sie bereit: Anmeldung per Clubcode, gemeinsame Datenbank, Live-Updates, Freunde online. */
(function () {
  'use strict';
  if (window.claude) return;

  var LS = 'wupa-club-v1';
  var token = null, me = null, peerId = null;
  var users = Object.create(null);
  var offline = false;
  var cache = { words: null, history: null };
  var listeners = { words: [], history: [] };
  var peers = [], myPresence = {}, peerHandlers = [], peerTimer = null;
  var ws = null, wsTries = 0, wsTimer = null, pingTimer = null, wasConnected = false;
  var resolveReady;
  var ready = new Promise(function (r) { resolveReady = r; });

  function lsGet() { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) { return null; } }
  function lsSet(v) { try { if (v) localStorage.setItem(LS, JSON.stringify(v)); else localStorage.removeItem(LS); } catch (e) { /* privater Modus */ } }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  /* ---------- HTTP ---------- */
  function fail(code, status) { var e = new Error(code); e.code = code; e.status = status; return e; }
  function api(method, path, body) {
    var opts = { method: method, headers: {} };
    if (token) opts.headers.authorization = 'Bearer ' + token;
    if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    if (path === '/api/progress' && opts.body && opts.body.length < 60000) opts.keepalive = true;
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok) return data;
        if (res.status === 401 && path !== '/api/join') { lsSet(null); token = null; showJoin('Bitte melde dich neu an.'); throw fail('revoked', 401); }
        if (res.status === 507) throw fail('quota_exceeded', 507);
        if (res.status === 413 || res.status === 429) throw fail('resource_exhausted', res.status);
        var e = fail(res.status >= 500 ? 'unavailable' : 'invalid_argument', res.status);
        e.server = data.error;
        throw e;
      });
    }, function () { throw fail('unavailable', 0); });
  }

  /* ---------- Anmeldung ---------- */
  // Release-Version: steht immer unten rechts und im Anmeldefenster.
  var verText = 'Version …';
  function paintVersion() {
    var els = document.querySelectorAll('[data-wver]');
    for (var i = 0; i < els.length; i++) els[i].textContent = verText;
  }
  function loadVersion() {
    Promise.all([
      fetch('/version.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).catch(function () { return null; }),
      fetch('/api/version', { cache: 'no-store' }).then(function (r) { return r.json(); }).catch(function () { return null; })
    ]).then(function (a) {
      var v = a[0], c = a[1];
      verText = 'Version ' + (v ? v.version + ' · ' + v.build : '?') + (c ? ' · Clubcode ' + (c.clubcode ? 'gesetzt' : 'FEHLT') : '');
      paintVersion();
    });
  }
  function addBadge() {
    if (document.querySelector('[data-wver-badge]')) return;
    var b = document.createElement('div');
    b.setAttribute('data-wver', ''); b.setAttribute('data-wver-badge', '');
    b.style.cssText = 'position:fixed;right:6px;bottom:4px;z-index:101;font:12px system-ui,sans-serif;opacity:.65;pointer-events:none;color:var(--ink,#111)';
    document.body.appendChild(b); paintVersion();
  }
  loadVersion();
  if (document.body) addBadge(); else document.addEventListener('DOMContentLoaded', addBadge);

  var overlay = null;
  function showJoin(msg) {
    if (overlay) { var er = overlay.querySelector('[data-err]'); if (er) er.textContent = msg || ''; return; }
    overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Anmelden');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:16px;background:rgba(10,14,50,.7);font-family:var(--font-body,system-ui,sans-serif)';
    var box = document.createElement('form');
    box.style.cssText = 'width:100%;max-width:420px;display:flex;flex-direction:column;gap:10px;padding:18px;background:var(--card,#fff);color:var(--ink,#111);border:2.5px solid var(--ink,#111);border-radius:16px 5px 14px 6px / 6px 14px 5px 16px;box-shadow:3px 3px 0 var(--ink,#111);font-size:19px';
    var fld = 'min-height:52px;font:inherit;font-size:22px;padding:6px 12px;border:2.5px solid var(--ink,#111);border-radius:12px;background:var(--paper,#fff);color:inherit';
    var lbl = 'font-size:16px;opacity:.75';
    box.innerHTML =
      '<h1 style="margin:0;font-family:var(--font-display,inherit);font-weight:400;font-size:32px">Wupa Akademie</h1>' +
      '<div>Melde dich mit deinem Namen an. Den Clubcode bekommst du von dem, der dich eingeladen hat.</div>' +
      '<label for="wj-code" style="' + lbl + '">Clubcode</label>' +
      '<input id="wj-code" autocomplete="off" autocapitalize="none" spellcheck="false" style="' + fld + '">' +
      '<label for="wj-name" style="' + lbl + '">Dein Name</label>' +
      '<input id="wj-name" maxlength="24" autocomplete="username" style="' + fld + '">' +
      '<label for="wj-pin" style="' + lbl + '">Dein PIN (mindestens 4 Zeichen). Neu hier? Such dir einen aus und merk ihn dir.</label>' +
      '<input id="wj-pin" type="password" maxlength="32" autocomplete="current-password" style="' + fld + '">' +
      '<div data-err role="alert" style="color:var(--bad,#c00);font-size:17px"></div>' +
      '<div data-wver style="font-size:14px;opacity:.65"></div>' +
      '<button type="submit" style="min-height:54px;font:inherit;font-family:var(--font-display,inherit);font-size:24px;cursor:pointer;border:2.5px solid var(--ink,#111);border-radius:16px 5px 14px 6px / 6px 14px 5px 16px;background:var(--pink,#d63a69);color:var(--on-pink,#fff);box-shadow:3px 3px 0 var(--ink,#111)">Los geht\u2019s</button>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    paintVersion();
    var errEl = box.querySelector('[data-err]');
    errEl.textContent = msg || '';
    box.addEventListener('submit', function (e) {
      e.preventDefault();
      var code = box.querySelector('#wj-code').value, name = box.querySelector('#wj-name').value.trim(), pin = box.querySelector('#wj-pin').value;
      if (!code.trim() || !name || !pin) { errEl.textContent = 'Bitte alles ausfüllen.'; return; }
      if (pin.length < 4) { errEl.textContent = 'Der PIN braucht mindestens 4 Zeichen.'; return; }
      errEl.textContent = '';
      api('POST', '/api/join', { code: code, name: name, pin: pin }).then(function (r) {
        token = r.token; me = r.user;
        lsSet({ token: token });
        overlay.remove(); overlay = null;
        users[me.id] = me;
        return start();
      }).catch(function (err) {
        errEl.textContent = err.server === 'wrong_code' ? 'Der Clubcode stimmt nicht.' :
          err.server === 'wrong_pin' ? 'Dieser Name gehört schon jemandem. Der PIN passt nicht.' :
          err.server === 'bad_pin' ? 'Der PIN braucht mindestens 4 Zeichen.' :
          err.server === 'club_full' ? 'Der Club ist voll.' :
          err.server === 'rate_limited' || err.code === 'resource_exhausted' ? 'Zu viele Versuche. Warte eine Minute.' :
          err.server === 'not_configured' ? 'Der Server hat noch keinen Clubcode.' :
          'Das hat nicht geklappt. Prüfe die Verbindung.';
      });
    });
    setTimeout(function () { var c = box.querySelector('#wj-code'); if (c) c.focus(); }, 50);
  }

  function boot() {
    var saved = lsGet();
    if (saved && saved.token) {
      token = saved.token;
      api('GET', '/api/me').then(function (r) { me = r.user; users[me.id] = me; return start(); })
        .catch(function (err) {
          if (err.code === 'unavailable') { offline = true; resolveReady(); }
        });
    } else {
      if (document.body) showJoin(); else document.addEventListener('DOMContentLoaded', function () { showJoin(); });
    }
  }

  function start() {
    return api('GET', '/api/users').then(function (r) {
      r.users.forEach(function (u) { users[u.id] = u; });
    }).catch(function () {}).then(function () {
      connect();
      resolveReady();
    });
  }

  /* ---------- Live-Verbindung ---------- */
  function connect() {
    clearTimeout(wsTimer);
    try {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/live');
    } catch (e) { return; }
    ws.onopen = function () {
      wsTries = 0;
      ws.send(JSON.stringify({ t: 'auth', token: token }));
      clearInterval(pingTimer);
      pingTimer = setInterval(function () { try { ws.send('ping'); } catch (e) { /* weg */ } }, 25000);
    };
    ws.onmessage = function (ev) {
      if (ev.data === 'pong') return;
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'ready') {
        peerId = m.peer;
        (m.users || []).forEach(function (u) { users[u.id] = u; });
        if (Object.keys(myPresence).length) sendPresence();
        if (wasConnected) refreshAll();
        wasConnected = true;
      } else if (m.t === 'doc') {
        applyDoc(m);
      } else if (m.t === 'peers') {
        peers = (m.peers || []).map(toPeer);
        schedulePeers();
      } else if (m.t === 'users') {
        (m.users || []).forEach(function (u) { users[u.id] = u; });
      }
    };
    ws.onclose = function (ev) {
      clearInterval(pingTimer);
      if (ev.code === 4401) { lsSet(null); token = null; showJoin('Bitte melde dich neu an.'); return; }
      var wait = Math.min(15000, 1000 * Math.pow(2, wsTries++));
      wsTimer = setTimeout(connect, wait);
    };
  }
  function refreshAll() { Object.keys(cache).forEach(function (c) { if (cache[c]) load(c).then(function () { emit(c); }).catch(function () {}); }); }

  /* ---------- Datenbank ---------- */
  function load(coll) {
    return api('GET', '/api/col/' + coll).then(function (r) {
      var m = new Map();
      r.docs.forEach(function (d) { m.set(d.id, d.data); });
      cache[coll] = m;
    });
  }
  function snapshot(coll, q) {
    var docs = [];
    cache[coll].forEach(function (data, id) {
      docs.push({ id: id, exists: true, data: function () { return clone(data); }, metadata: { fromCache: false, hasPendingWrites: false } });
    });
    if (q && q.f) {
      docs.sort(function (a, b) {
        var x = a.data()[q.f], y = b.data()[q.f];
        return (x < y ? -1 : x > y ? 1 : 0) * (q.d === 'desc' ? -1 : 1);
      });
    } else {
      docs.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    }
    if (q && q.n) docs = docs.slice(0, q.n);
    return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function emit(coll) {
    if (!cache[coll]) return;
    listeners[coll].slice().forEach(function (l) { try { l.next(snapshot(coll, l.q)); } catch (e) { console.error(e); } });
  }
  function applyDoc(m) {
    if (!cache[m.coll]) return;
    if (m.op === 'delete') cache[m.coll].delete(m.id); else cache[m.coll].set(m.id, m.data);
    emit(m.coll);
  }
  function query(coll, q) {
    return {
      orderBy: function (f, d) { return query(coll, Object.assign({}, q, { f: f, d: d })); },
      limit: function (n) { return query(coll, Object.assign({}, q, { n: n })); },
      get: function () { return ensure(coll).then(function () { return snapshot(coll, q); }); },
      onSnapshot: function (next, error) {
        var l = { next: next, q: q };
        listeners[coll].push(l);
        ensure(coll).then(function () { next(snapshot(coll, q)); }, function (e) { if (error) error(e); });
        return function () { listeners[coll] = listeners[coll].filter(function (x) { return x !== l; }); };
      },
    };
  }
  var loading = {};
  function ensure(coll) {
    if (cache[coll]) return Promise.resolve();
    return loading[coll] || (loading[coll] = load(coll).then(function () { delete loading[coll]; }, function (e) { delete loading[coll]; throw e; }));
  }
  function checkColl(c) { if (c !== 'words' && c !== 'history') throw new TypeError('Unbekannte Sammlung: ' + c); return c; }
  function docRef(path) {
    var p = path.split('/');
    if (p[0] === 'data' && p[1] === 'users' && p[3] === 'progress' && p.length === 4) {
      return {
        id: 'progress', path: path,
        get: function () {
          return api('GET', '/api/progress').then(function (r) {
            return { id: 'progress', exists: !!r.state, data: function () { return r.state ? { state: r.state, ts: 0 } : undefined; } };
          });
        },
        set: function (d) { return api('PUT', '/api/progress', { state: d.state }).then(function () {}); },
      };
    }
    var coll = checkColl(p[0]), id = p[1];
    if (p.length !== 2 || !id) throw new TypeError('Ungültiger Pfad: ' + path);
    var url = '/api/doc/' + coll + '/' + encodeURIComponent(id);
    return {
      id: id, path: path,
      get: function () {
        return ensure(coll).then(function () {
          var d = cache[coll].get(id);
          return { id: id, exists: !!d, data: function () { return d ? clone(d) : undefined; } };
        });
      },
      set: function (d) { return api('PUT', url, d).then(function (r) { if (cache[coll]) { cache[coll].set(id, r.doc); emit(coll); } }); },
      update: function (d) { return api('PATCH', url, d).then(function (r) { if (cache[coll]) { cache[coll].set(id, r.doc); emit(coll); } }); },
      delete: function () { return api('DELETE', url).then(function () { if (cache[coll]) { cache[coll].delete(id); emit(coll); } }); },
    };
  }
  var dbNS = {
    doc: docRef,
    collection: function (path) {
      var coll = checkColl(path), q = query(coll, {});
      q.path = coll;
      q.doc = function (id) { return docRef(coll + '/' + (id || 'x' + Math.random().toString(36).slice(2, 12))); };
      q.add = function (d) {
        var id = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        var ref = docRef(coll + '/' + id);
        return ref.set(d).then(function () { return ref; });
      };
      return q;
    },
  };

  /* ---------- Personen ---------- */
  function profile(id) {
    var u = users[id];
    return { id: id, name: u ? u.name : '', avatarUrl: '', color: u ? 'hsl(' + u.color + ' 70% 60%)' : '#888', email: null, isMe: !!me && id === me.id, guest: false };
  }
  var userNS = {
    id: function () { return Promise.resolve(me ? me.id : null); },
    me: function () { return Promise.resolve(Object.assign(profile(me ? me.id : ''), { isOwner: false, canEdit: false })); },
    isOwner: function () { return Promise.resolve(false); },
    canEdit: function () { return Promise.resolve(false); },
    can: function () { return Promise.resolve(true); },
    profiles: function (ids) {
      ids = typeof ids === 'string' ? [ids] : ids;
      var missing = ids.filter(function (i) { return !users[i]; });
      var step = missing.length ? api('GET', '/api/users').then(function (r) { r.users.forEach(function (u) { users[u.id] = u; }); }).catch(function () {}) : Promise.resolve();
      return step.then(function () { var out = {}; ids.forEach(function (i) { out[i] = profile(i); }); return out; });
    },
  };

  /* ---------- Freunde online ---------- */
  function toPeer(p) {
    return { peer: p.peer, by: p.by, isMe: !!me && p.by === me.id, sameTab: p.peer === peerId, kind: 'viewer', guest: false, presence: p.presence || {}, updatedAt: p.updatedAt || 0 };
  }
  function schedulePeers() {
    if (peerTimer) return;
    peerTimer = setTimeout(function () {
      peerTimer = null;
      var change = { peers: peers, joined: [], left: [], updated: [] };
      peerHandlers.slice().forEach(function (h) { try { h(change); } catch (e) { console.error(e); } });
    }, 30);
  }
  var presTimer = null;
  function sendPresence() {
    clearTimeout(presTimer);
    presTimer = setTimeout(function () {
      if (ws && ws.readyState === 1 && peerId) ws.send(JSON.stringify({ t: 'presence', presence: myPresence }));
    }, 60);
  }
  var roomNS = {
    presence: function (patch) {
      Object.keys(patch).forEach(function (k) { if (patch[k] === null) delete myPresence[k]; else myPresence[k] = patch[k]; });
      sendPresence();
      return Promise.resolve();
    },
    peers: function () { return peers; },
    onPeers: function (h) {
      peerHandlers.push(h);
      schedulePeers();
      return function () { peerHandlers = peerHandlers.filter(function (x) { return x !== h; }); };
    },
    connected: function () { return !!ws && ws.readyState === 1; },
  };

  /* ---------- Datei speichern ---------- */
  var dlNS = {
    save: function (req) {
      return new Promise(function (resolve, reject) {
        try {
          var blob = new Blob([req.data], { type: /\.csv$/i.test(req.filename) ? 'text/csv;charset=utf-8' : 'application/octet-stream' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = req.filename;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
          resolve({ status: 'saved' });
        } catch (e) { reject({ code: 'unavailable', message: String(e) }); }
      });
    },
  };

  window.claude = {
    use: function (name) {
      return ready.then(function () {
        if (offline) return null;
        return { user: userNS, db: dbNS, room: roomNS, downloads: dlNS }[name] || null;
      });
    },
  };
  boot();
})();
