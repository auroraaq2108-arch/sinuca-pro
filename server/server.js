// server.js — servidor da Sinuca Pro: entrega o jogo, salas com senha,
// fila rápida (busca de adversário) e ranking de pontos.
// Sem dependências: rode com "node server.js" (ou o INICIAR-SERVIDOR.bat).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { acceptKey, wrap } = require('./ws-mini');

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

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || file.includes('ranking.json')) { res.writeHead(403); res.end('403'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

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
const rooms = new Map(); // code -> { seats: [conn|null, conn|null], reported }
const queue = [];        // { conn, mode, bestOf }
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

function leave(conn) {
  const room = conn.room;
  if (!room) return;
  const other = room.seats[1 - conn.seat];
  room.seats[conn.seat] = null;
  if (other) other.send(JSON.stringify({ t: 'left' }));
  if (conn.code && !room.seats[0] && !room.seats[1]) rooms.delete(conn.code);
  conn.room = null;
  conn.seat = -1;
  conn.code = null;
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

  conn.onmessage = raw => {
    if (raw.length > 20000) return; // proteção básica
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // identificação do jogador (para o ranking)
    if (msg.t === 'hello') {
      const id = String(msg.id || '').slice(0, 40);
      if (!id) return;
      conn.playerId = id;
      conn.playerName = String(msg.name || 'Jogador').slice(0, 14).trim() || 'Jogador';
      const rec = playerRec(id, conn.playerName);
      saveDB();
      conn.send(JSON.stringify({ t: 'pts', pts: rec.pts, w: rec.w, l: rec.l }));
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

    // fila rápida: pareia dois jogadores da mesma modalidade E mesma aposta
    if (msg.t === 'queue') {
      leave(conn);
      unqueue(conn);
      const mode = msg.mode === 'tresbolas' ? 'tresbolas' : '8ball';
      const bestOf = [1, 3, 5, 9, 29].includes(msg.bestOf) ? msg.bestOf : (mode === 'tresbolas' ? 9 : 3);
      const stake = [0, 25, 100, 250, 500, 1000, 2500].includes(msg.stake) ? msg.stake : 0;
      const i = queue.findIndex(q => q.mode === mode && q.stake === stake);
      if (i >= 0) {
        const other = queue.splice(i, 1)[0];
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
      return;
    }

    if (msg.t === 'create') {
      leave(conn);
      unqueue(conn);
      const want = String(msg.code || '').toUpperCase().trim();
      if (want && !/^[A-Z0-9]{3,8}$/.test(want)) {
        conn.send(JSON.stringify({ t: 'err', m: 'Senha inválida: use 3 a 8 letras/números, sem espaço' }));
        return;
      }
      if (want && rooms.has(want)) {
        conn.send(JSON.stringify({ t: 'err', m: 'Essa senha já está em uso, escolha outra' }));
        return;
      }
      const stake = [0, 25, 100, 250, 500, 1000, 2500].includes(msg.stake) ? msg.stake : 0;
      conn.code = want || makeCode();
      conn.room = { seats: [conn, null], reported: true, stake };
      conn.seat = 0;
      rooms.set(conn.code, conn.room);
      conn.send(JSON.stringify({ t: 'created', code: conn.code, stake }));
      return;
    }

    if (msg.t === 'join') {
      leave(conn);
      unqueue(conn);
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

    // qualquer outra mensagem é do jogo: repassa para o outro jogador
    if (conn.room) {
      if (msg.t === 'start') conn.room.reported = false; // nova partida pode pontuar
      const other = conn.room.seats[1 - conn.seat];
      if (other) other.send(raw);
    }
  };

  conn.onclose = () => {
    unqueue(conn);
    leave(conn);
  };
});

server.listen(PORT, () => {
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
});
