// server.js — servidor da Sinuca Pro: entrega o jogo, salas com senha,
// fila rápida (busca de adversário) e ranking de pontos.
// Sem dependências: rode com "node server.js" (ou o INICIAR-SERVIDOR.bat).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { acceptKey, wrap } = require('./ws-mini');
const accounts = require('./accounts');

const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, '..'); // pasta sinuca/

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// versão atual do jogo: cliente com número menor é forçado a recarregar
// (IMPORTANTE: ao mexer em js/css, bump aqui + ?v= + "versão N" no index.html)
const APP_VER = 27;

// senha do painel do dono: DEVE vir da variável de ambiente ADMIN_PASS no Render.
// Sem ela (ou usando a antiga que vazou no repositório), o painel fica DESATIVADO.
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const ADMIN_ON = ADMIN_PASS.length >= 8 && ADMIN_PASS !== 'dono-sinuca-2026';
if (!ADMIN_ON) console.log('AVISO: /admin e /reports DESATIVADOS. Defina ADMIN_PASS (8+ caracteres) no Render pra ativar.');

// ---- limite de requisições por IP (anti força-bruta e anti-spam) ----
const rlStore = new Map();
function rateOk(key, max, windowMs) {
  const now = Date.now();
  const arr = (rlStore.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { rlStore.set(key, arr); return false; }
  arr.push(now);
  rlStore.set(key, arr);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of rlStore) {
    const keep = arr.filter(t => now - t < 3600000);
    if (keep.length) rlStore.set(k, keep); else rlStore.delete(k);
  }
}, 600000).unref?.();
function clientIp(req) {
  const xff = req.headers['x-forwarded-for']; // o Render põe o IP real aqui
  return (xff ? String(xff).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}

// cabeçalhos de segurança em toda resposta
function secHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

// lê o corpo JSON de um POST (com limite de tamanho)
function readJson(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 4000) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body)); } catch (e) { cb(null); } });
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  secHeaders(res);
  const ip = clientIp(req);

  // ---- contas: cadastro / login / sessão ----
  if (req.method === 'POST' && url === '/register') {
    if (!rateOk('reg:' + ip, 6, 3600000)) return sendJson(res, 429, { err: 'Muitas contas criadas desse aparelho. Tente daqui a pouco.' });
    readJson(req, d => {
      if (!d) return sendJson(res, 400, { err: 'dados inválidos' });
      accounts.register(d).then(r => sendJson(res, r.err ? 400 : 200, r))
        .catch(() => sendJson(res, 500, { err: 'erro no servidor' }));
    });
    return;
  }
  if (req.method === 'POST' && url === '/login') {
    if (!rateOk('login:' + ip, 12, 600000)) return sendJson(res, 429, { err: 'Muitas tentativas. Espere alguns minutos e tente de novo.' });
    readJson(req, d => {
      if (!d) return sendJson(res, 400, { err: 'dados inválidos' });
      accounts.login(d).then(r => sendJson(res, r.err ? 400 : 200, r))
        .catch(() => sendJson(res, 500, { err: 'erro no servidor' }));
    });
    return;
  }
  if (req.method === 'POST' && url === '/resume') {
    readJson(req, d => {
      if (!d || !d.token) return sendJson(res, 400, { err: 'sem token' });
      const r = accounts.resume(d.token);
      sendJson(res, r.err ? 401 : 200, r);
    });
    return;
  }
  // salva o saldo de moedas de teste na conta (client-trusted por ora: só moeda de teste;
  // vira server-authoritative quando entrar dinheiro real). Teto pra evitar valores absurdos.
  if (req.method === 'POST' && url === '/wallet') {
    if (!rateOk('wallet:' + ip, 120, 60000)) return sendJson(res, 429, { err: 'devagar' });
    readJson(req, d => {
      const u = d && d.token && accounts.userByToken(d.token);
      if (!u) return sendJson(res, 401, { err: 'não logado' });
      if (typeof d.coins === 'number' && d.coins >= 0 && d.coins <= 10000000) accounts.setCoins(u.id, d.coins);
      sendJson(res, 200, { coins: accounts.byId(u.id).coins });
    });
    return;
  }

  // ---- painel do dono: métricas de jogadores ----
  if (url.split('?')[0] === '/admin') {
    if (!ADMIN_ON) { res.writeHead(503); res.end('Painel desativado — configure ADMIN_PASS no servidor.'); return; }
    if (!rateOk('admin:' + ip, 20, 600000)) { res.writeHead(429); res.end('devagar'); return; }
    const senha = (url.split('senha=')[1] || '').split('&')[0];
    if (senha !== ADMIN_PASS) { res.writeHead(403); res.end('403 - senha errada'); return; }
    const s = accounts.adminStats();
    const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const tbl = (title, rows, cols) =>
      `<h2>${title}</h2><table><tr>${cols.map(c => `<th>${c[0]}</th>`).join('')}</tr>` +
      (rows.length ? rows.map(r => `<tr>${cols.map(c => `<td>${esc(r[c[1]])}</td>`).join('')}</tr>`).join('') : '<tr><td colspan="9">—</td></tr>') +
      '</table>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Painel — Sinuca Pro</title>
<style>body{font-family:system-ui;background:#0a1826;color:#e9eef4;padding:16px}h1{color:#f0b429}h2{color:#f0b429;font-size:1.1rem;margin-top:22px}table{border-collapse:collapse;width:100%;margin-top:6px}td,th{border:1px solid #2a4a6b;padding:7px;text-align:left}th{background:#142c44}.big{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0}.card{background:#142c44;border:1px solid #2a4a6b;border-radius:10px;padding:14px 20px}.card b{font-size:1.8rem;color:#f0b429;display:block}</style>
</head><body><h1>📊 Painel Sinuca Pro</h1>
<div class="big"><div class="card"><b>${s.total}</b>cadastrados</div><div class="card"><b>${s.ativos24h}</b>ativos (24h)</div><div class="card"><b>${s.horasTotais}h</b>jogadas no total</div></div>
${tbl('⏱ Mais horas jogadas', s.maisHoras, [['Apelido', 'nick'], ['Horas', 'horas'], ['Logins', 'logins'], ['Pontos', 'pts']])}
${tbl('🔁 Mais logins', s.maisLogins, [['Apelido', 'nick'], ['Logins', 'logins'], ['Horas', 'horas']])}
${tbl('🤝 Afiliados', s.afiliados, [['Apelido', 'nick'], ['Indicados', 'indicados'], ['Ganhou (moedas)', 'ganhou']])}
<p style="color:#7d92a8;margin-top:20px">Atenção: no plano grátis os dados somem quando o servidor reinicia. Trocar por banco permanente antes do dinheiro real.</p>
</body></html>`);
    return;
  }

  // jogadores enviam reportes de erro
  if (req.method === 'POST' && url === '/report') {
    if (!rateOk('report:' + ip, 8, 3600000)) return sendJson(res, 429, { ok: false });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4000) req.destroy(); });
    req.on('end', () => {
      try {
        const r = JSON.parse(body);
        const rep = {
          quando: new Date().toISOString(),
          nome: String(r.nome || 'anônimo').slice(0, 20),
          texto: String(r.texto || '').slice(0, 500),
          aparelho: String(r.aparelho || '').slice(0, 160),
        };
        if (!rep.texto.trim()) throw new Error('vazio');
        reports.push(rep);
        if (reports.length > 500) reports.shift();
        saveReports();
        console.log(`[REPORTE] ${rep.nome}: ${rep.texto}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400);
        res.end('{"ok":false}');
      }
    });
    return;
  }

  // página do dono: lista os reportes (protegida por senha)
  if (url.split('?')[0] === '/reports') {
    if (!ADMIN_ON) { res.writeHead(503); res.end('Painel desativado — configure ADMIN_PASS no servidor.'); return; }
    if (!rateOk('admin:' + ip, 20, 600000)) { res.writeHead(429); res.end('devagar'); return; }
    const senha = (url.split('senha=')[1] || '').split('&')[0];
    if (senha !== ADMIN_PASS) { res.writeHead(403); res.end('403 - senha errada'); return; }
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rows = reports.slice().reverse().map(r =>
      `<tr><td>${esc(r.quando.replace('T', ' ').slice(0, 16))}</td><td>${esc(r.nome)}</td><td>${esc(r.texto)}</td><td class="ua">${esc(r.aparelho)}</td></tr>`
    ).join('');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reportes — Sinuca Pro</title>
<style>body{font-family:system-ui;background:#0a1826;color:#e9eef4;padding:16px}h1{color:#f0b429}table{border-collapse:collapse;width:100%}td,th{border:1px solid #2a4a6b;padding:8px;text-align:left;vertical-align:top}th{background:#142c44}.ua{color:#7d92a8;font-size:.75rem;max-width:220px;word-break:break-all}</style>
</head><body><h1>🐞 Reportes (${reports.length})</h1><p>Atenção: no plano grátis os reportes somem quando o servidor reinicia — confira com frequência.</p>
<table><tr><th>Quando</th><th>Quem</th><th>Reporte</th><th>Aparelho</th></tr>${rows || '<tr><td colspan="4">Nenhum reporte ainda.</td></tr>'}</table></body></html>`);
    return;
  }

  let p = decodeURIComponent(url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || file.includes(path.join('server', 'data'))) { res.writeHead(403); res.end('403'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // sempre a versão mais nova: jogador com jogo desatualizado não conversa com o novo
      'Cache-Control': ['.html', '.js', '.css', '.json'].includes(ext) ? 'no-store' : 'public, max-age=3600',
    });
    res.end(data);
  });
});

// ---------- reportes de erro dos jogadores ----------
const REPORTS_FILE = path.join(__dirname, 'data', 'reports.json');
let reports = [];
try { reports = JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8')); } catch (e) { /* primeiro uso */ }
function saveReports() {
  try {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports));
  } catch (e) { console.log('não consegui salvar reportes:', e.message); }
}

// ---------- ranking (arquivo JSON — atenção: na nuvem grátis o disco
// não é permanente, o ranking zera quando o servidor reinicia) ----------
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'ranking.json');
let DB = { players: {} };
try { DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { /* primeiro uso */ }

let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(DB));
    } catch (e) { console.log('não consegui salvar o ranking:', e.message); }
  }, 300);
}

function playerRec(id, name) {
  if (!DB.players[id]) DB.players[id] = { name: name || 'Jogador', pts: 1000, w: 0, l: 0 };
  if (name) DB.players[id].name = name;
  return DB.players[id];
}

// Elo: vitória contra alguém mais forte vale mais pontos
function elo(winner, loser) {
  const expected = 1 / (1 + Math.pow(10, (loser.pts - winner.pts) / 400));
  const d = Math.max(4, Math.round(32 * (1 - expected)));
  winner.pts += d;
  loser.pts = Math.max(0, loser.pts - d);
  winner.w++;
  loser.l++;
  return d;
}

// ---------- salas e fila ----------
const rooms = new Map();         // code -> { seats: [conn|null, conn|null], reported, stake }
const queue = [];                // { conn, mode, bestOf, stake }
const pendingResume = new Map(); // playerId -> { room, seat, code, timer } (queda de conexão)
const allConns = new Set();      // todo mundo conectado (pro letreiro de vitórias)
const feed = [];                 // últimas vitórias valendo moedas
let qmCounter = 0;
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I pra não confundir

function makeCode() {
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += CHARS[(Math.random() * CHARS.length) | 0];
  } while (rooms.has(c));
  return c;
}

function unqueue(conn) {
  const i = queue.findIndex(q => q.conn === conn);
  if (i >= 0) queue.splice(i, 1);
}

// final = saiu de propósito · não-final = conexão caiu (vaga fica guardada 45s)
function leave(conn, final) {
  const room = conn.room;
  if (!room) {
    conn.room = null; conn.seat = -1; conn.code = null;
    return;
  }
  const other = room.seats[1 - conn.seat];
  room.seats[conn.seat] = null;
  if (!final && other && conn.playerId) {
    other.send(JSON.stringify({ t: 'peer-off' }));
    const id = conn.playerId, seat = conn.seat, code = conn.code;
    const timer = setTimeout(() => {
      pendingResume.delete(id);
      const o2 = room.seats[1 - seat];
      if (o2) o2.send(JSON.stringify({ t: 'left' }));
      if (code) rooms.delete(code);
    }, 45000);
    pendingResume.set(conn.playerId, { room, seat, code, timer });
  } else {
    if (other) other.send(JSON.stringify({ t: 'left' }));
    if (conn.code && !room.seats[0] && !room.seats[1]) rooms.delete(conn.code);
  }
  conn.room = null;
  conn.seat = -1;
  conn.code = null;
}

// ---------- aceite de partida (fila encontrou: os dois confirmam) ----------
function cancelPM(pm, decliner, reason) {
  clearTimeout(pm.timer);
  const sides = [pm.a, pm.b];
  sides.forEach(c => { if (c) c.pm = null; });
  sides.forEach((c, i) => {
    if (!c || !c.alive) return;
    if (c === decliner) {
      c.send(JSON.stringify({ t: 'nomatch', m: 'Você recusou a partida.' }));
    } else if (pm.acc[i]) {
      // quem aceitou volta pra frente da fila automaticamente
      queue.unshift({ conn: c, mode: pm.mode, bestOf: i === 0 ? pm.bestOfA : pm.bestOfB, stake: pm.stake });
      c.send(JSON.stringify({ t: 'nomatch', m: reason || 'O adversário recusou.', requeued: true }));
      c.send(JSON.stringify({ t: 'queued', stake: pm.stake }));
    } else {
      c.send(JSON.stringify({ t: 'nomatch', m: reason || 'Partida cancelada.' }));
    }
  });
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
  );
  const conn = wrap(socket);
  conn.playerId = null;
  conn.playerName = 'Jogador';
  conn.room = null;
  conn.seat = -1;
  conn.code = null;
  conn.pm = null; // aceite de partida pendente
  allConns.add(conn);

  conn.onmessage = raw => {
    if (raw.length > 20000) return; // proteção básica
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // identificação do jogador (para o ranking e a reconexão)
    if (msg.t === 'hello') {
      // cliente desatualizado (versão velha em cache): manda recarregar sozinho
      if (typeof msg.v === 'number' && msg.v < APP_VER) {
        conn.send(JSON.stringify({ t: 'reload' }));
        return;
      }
      const id = String(msg.id || '').slice(0, 40);
      if (!id) return;
      conn.playerId = id;
      conn.playerName = String(msg.name || 'Jogador').slice(0, 14).trim() || 'Jogador';
      const rec = playerRec(id, conn.playerName);
      saveDB();
      conn.send(JSON.stringify({ t: 'pts', pts: rec.pts, w: rec.w, l: rec.l }));
      if (feed.length) conn.send(JSON.stringify({ t: 'feedlist', list: feed.slice(-6) }));
      // caiu no meio de uma partida? devolve a vaga guardada
      const pend = pendingResume.get(id);
      if (pend && !pend.room.seats[pend.seat]) {
        clearTimeout(pend.timer);
        pendingResume.delete(id);
        conn.room = pend.room;
        conn.seat = pend.seat;
        conn.code = pend.code;
        pend.room.seats[pend.seat] = conn;
        conn.send(JSON.stringify({ t: 'resumed', seat: pend.seat }));
        const other = pend.room.seats[1 - pend.seat];
        if (other) other.send(JSON.stringify({ t: 'peer-back' }));
      }
      return;
    }

    // aceite da partida encontrada na fila
    if (msg.t === 'accept') {
      const pm = conn.pm;
      if (!pm) return;
      pm.acc[conn === pm.a ? 0 : 1] = true;
      if (pm.acc[0] && pm.acc[1]) {
        clearTimeout(pm.timer);
        pm.a.pm = null; pm.b.pm = null;
        const code = 'QM' + (++qmCounter);
        const room = { seats: [pm.a, pm.b], reported: true, stake: pm.stake };
        rooms.set(code, room);
        pm.a.room = room; pm.a.seat = 0; pm.a.code = code;
        pm.b.room = room; pm.b.seat = 1; pm.b.code = code;
        pm.a.send(JSON.stringify({ t: 'matched', seat: 0, mode: pm.mode, bestOf: pm.bestOfA, stake: pm.stake, name: pm.b.playerName }));
        pm.b.send(JSON.stringify({ t: 'matched', seat: 1, mode: pm.mode, bestOf: pm.bestOfA, stake: pm.stake, name: pm.a.playerName }));
      } else {
        conn.send(JSON.stringify({ t: 'waitaccept' }));
      }
      return;
    }
    if (msg.t === 'decline') {
      if (conn.pm) cancelPM(conn.pm, conn);
      return;
    }

    // ranking: top 20 + a posição de quem pediu
    if (msg.t === 'top') {
      const list = Object.values(DB.players)
        .sort((a, b) => b.pts - a.pts)
        .slice(0, 20)
        .map(p => ({ name: p.name, pts: p.pts, w: p.w, l: p.l }));
      const rec = conn.playerId ? DB.players[conn.playerId] : null;
      const me = rec ? { name: rec.name, pts: rec.pts, w: rec.w, l: rec.l } : null;
      conn.send(JSON.stringify({ t: 'top', list, me }));
      return;
    }

    // fila rápida: achou par da mesma modalidade+aposta → conecta na hora
    if (msg.t === 'queue') {
      leave(conn, true);
      unqueue(conn);
      const mode = msg.mode === 'tresbolas' ? 'tresbolas' : '8ball';
      const bestOf = [1, 3, 5, 9, 29].includes(msg.bestOf) ? msg.bestOf : (mode === 'tresbolas' ? 9 : 3);
      const stake = [0, 10, 25, 100, 250, 500, 1000, 2500].includes(msg.stake) ? msg.stake : 10;
      // ignora entradas mortas na fila (conexão caiu) antes de parear
      let other = null;
      while (queue.length) {
        const idx = queue.findIndex(q => q.mode === mode && q.stake === stake);
        if (idx < 0) break;
        const cand = queue.splice(idx, 1)[0];
        if (cand.conn && cand.conn.alive && cand.conn !== conn) { other = cand; break; }
      }
      if (other) {
        const code = 'QM' + (++qmCounter);
        const room = { seats: [other.conn, conn], reported: true, stake };
        rooms.set(code, room);
        other.conn.room = room; other.conn.seat = 0; other.conn.code = code;
        conn.room = room; conn.seat = 1; conn.code = code;
        other.conn.send(JSON.stringify({ t: 'matched', seat: 0, mode, bestOf: other.bestOf, stake, name: conn.playerName }));
        conn.send(JSON.stringify({ t: 'matched', seat: 1, mode, bestOf: other.bestOf, stake, name: other.conn.playerName }));
      } else {
        queue.push({ conn, mode, bestOf, stake });
        conn.send(JSON.stringify({ t: 'queued', stake }));
      }
      return;
    }
    if (msg.t === 'unqueue') {
      unqueue(conn);
      conn.send(JSON.stringify({ t: 'unqueued' }));
      return;
    }

    // resultado da partida (só o anfitrião reporta, uma vez por partida)
    if (msg.t === 'result') {
      const room = conn.room;
      if (!room || conn.seat !== 0 || room.reported) return;
      const c0 = room.seats[0], c1 = room.seats[1];
      if (!c0 || !c1 || !c0.playerId || !c1.playerId || c0.playerId === c1.playerId) return;
      room.reported = true;
      const w = msg.w === 1 ? 1 : 0;
      const recW = playerRec([c0.playerId, c1.playerId][w]);
      const recL = playerRec([c0.playerId, c1.playerId][1 - w]);
      const d = elo(recW, recL);
      saveDB();
      const winnerConn = room.seats[w], loserConn = room.seats[1 - w];
      if (winnerConn) winnerConn.send(JSON.stringify({ t: 'pts', pts: recW.pts, w: recW.w, l: recW.l, delta: d }));
      if (loserConn) loserConn.send(JSON.stringify({ t: 'pts', pts: recL.pts, w: recL.w, l: recL.l, delta: -d }));
      // letreiro de vitórias: prova social pra quem está no menu
      if (room.stake > 0 && winnerConn && loserConn) {
        const prize = room.stake + Math.round(room.stake * 0.9);
        const item = { w: winnerConn.playerName, l: loserConn.playerName, v: prize };
        feed.push(item);
        if (feed.length > 20) feed.shift();
        const packed = JSON.stringify({ t: 'feed', item });
        for (const c of allConns) if (c.alive) c.send(packed);
      }
      return;
    }

    if (msg.t === 'create') {
      leave(conn, true);
      unqueue(conn);
      if (conn.pm) cancelPM(conn.pm, conn);
      const want = String(msg.code || '').toUpperCase().trim();
      if (want && !/^[A-Z0-9]{3,8}$/.test(want)) {
        conn.send(JSON.stringify({ t: 'err', m: 'Senha inválida: use 3 a 8 letras/números, sem espaço' }));
        return;
      }
      if (want && rooms.has(want)) {
        conn.send(JSON.stringify({ t: 'err', m: 'Essa senha já está em uso, escolha outra' }));
        return;
      }
      const stake = [0, 10, 25, 100, 250, 500, 1000, 2500].includes(msg.stake) ? msg.stake : 10;
      conn.code = want || makeCode();
      conn.room = { seats: [conn, null], reported: true, stake };
      conn.seat = 0;
      rooms.set(conn.code, conn.room);
      conn.send(JSON.stringify({ t: 'created', code: conn.code, stake }));
      return;
    }

    if (msg.t === 'join') {
      leave(conn, true);
      unqueue(conn);
      if (conn.pm) cancelPM(conn.pm, conn);
      const wanted = String(msg.code || '').toUpperCase().trim();
      const r = rooms.get(wanted);
      if (!r || !r.seats[0]) { conn.send(JSON.stringify({ t: 'err', m: 'Sala não encontrada' })); return; }
      if (r.seats[1]) { conn.send(JSON.stringify({ t: 'err', m: 'Sala cheia' })); return; }
      conn.room = r;
      conn.seat = 1;
      conn.code = wanted;
      r.seats[1] = conn;
      conn.send(JSON.stringify({ t: 'joined', name: r.seats[0].playerName, stake: r.stake || 0 }));
      r.seats[0].send(JSON.stringify({ t: 'peer', name: conn.playerName }));
      return;
    }

    // saída voluntária (botão sair/menu): libera a sala na hora
    if (msg.t === 'bye') {
      unqueue(conn);
      if (conn.pm) cancelPM(conn.pm, conn);
      leave(conn, true);
      return;
    }

    // qualquer outra mensagem é do jogo: repassa para o outro jogador
    if (conn.room) {
      if (msg.t === 'start') conn.room.reported = false; // nova partida pode pontuar
      const other = conn.room.seats[1 - conn.seat];
      if (other) {
        other.send(raw);
      } else if (msg.t === 'again' || msg.t === 'nextreq') {
        // pediu revanche mas o adversário já foi embora (e não está reconectando)
        let waiting = false;
        for (const p of pendingResume.values()) if (p.room === conn.room) waiting = true;
        if (!waiting) conn.send(JSON.stringify({ t: 'alone' }));
      }
    }
  };

  conn.onclose = () => {
    allConns.delete(conn);
    unqueue(conn);
    if (conn.pm) cancelPM(conn.pm, conn);
    leave(conn, false); // queda de conexão: vaga fica guardada pra reconectar
  };
});

accounts.ready.then(() => server.listen(PORT, () => {
  console.log('================================================');
  console.log('  SINUCA PRO — servidor ligado!');
  console.log('');
  if (process.env.RENDER || process.env.RAILWAY_ENVIRONMENT) {
    console.log('  Rodando na NUVEM: use o endereço público do');
    console.log('  provedor (ex: https://seu-jogo.onrender.com).');
    console.log('  Funciona de qualquer lugar do mundo!');
  } else {
    console.log('  Jogar neste PC:   http://localhost:' + PORT);
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const ni of nets[name] || []) {
        if (ni.family === 'IPv4' && !ni.internal) {
          console.log('  Jogar no celular: http://' + ni.address + ':' + PORT + '   (mesmo Wi-Fi)');
        }
      }
    }
    console.log('');
    console.log('  Para desligar: feche esta janela.');
  }
  console.log('================================================');

  // mantém o servidor acordado no plano grátis (senão dorme após 15 min sem ninguém
  // e ESQUECE contas/sessões). Faz o servidor visitar a si mesmo a cada 12 min.
  const SELF = process.env.RENDER_EXTERNAL_URL;
  if (SELF) {
    const https = require('https');
    setInterval(() => {
      https.get(SELF, r => r.resume()).on('error', () => {});
    }, 12 * 60 * 1000).unref?.();
    console.log('  keep-alive ligado (' + SELF + ')');
  }
}));
