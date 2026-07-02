// server.js — servidor da Sinuca Pro: entrega o jogo e conecta salas online.
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
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('403'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- salas (código de 4 letras) ----------
const rooms = new Map(); // code -> { seats: [conn|null, conn|null] }
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I pra não confundir

function makeCode() {
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += CHARS[(Math.random() * CHARS.length) | 0];
  } while (rooms.has(c));
  return c;
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
  );
  const conn = wrap(socket);
  let room = null, seat = -1, code = null;

  conn.onmessage = raw => {
    if (raw.length > 20000) return; // proteção básica
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.t === 'create') {
      leave();
      code = makeCode();
      room = { seats: [conn, null] };
      rooms.set(code, room);
      seat = 0;
      conn.send(JSON.stringify({ t: 'created', code }));
    } else if (msg.t === 'join') {
      leave();
      const wanted = String(msg.code || '').toUpperCase().trim();
      const r = rooms.get(wanted);
      if (!r || !r.seats[0]) { conn.send(JSON.stringify({ t: 'err', m: 'Sala não encontrada' })); return; }
      if (r.seats[1]) { conn.send(JSON.stringify({ t: 'err', m: 'Sala cheia' })); return; }
      room = r;
      seat = 1;
      code = wanted;
      r.seats[1] = conn;
      conn.send(JSON.stringify({ t: 'joined' }));
      r.seats[0].send(JSON.stringify({ t: 'peer' }));
    } else if (room) {
      // qualquer outra mensagem é do jogo: repassa para o outro jogador
      const other = room.seats[1 - seat];
      if (other) other.send(raw);
    }
  };

  function leave() {
    if (!room) return;
    const other = room.seats[1 - seat];
    room.seats[seat] = null;
    if (other) other.send(JSON.stringify({ t: 'left' }));
    if (code && !room.seats[0] && !room.seats[1]) rooms.delete(code);
    room = null;
    seat = -1;
    code = null;
  }
  conn.onclose = leave;
});

server.listen(PORT, () => {
  console.log('================================================');
  console.log('  SINUCA PRO — servidor ligado!');
  console.log('');
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
  console.log('================================================');
});
