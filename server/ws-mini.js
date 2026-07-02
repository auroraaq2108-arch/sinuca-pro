// ws-mini.js — WebSocket mínimo (RFC 6455), sem dependências externas.
// Usado pelo servidor (wrap) e pelos testes automatizados (connect).
const crypto = require('crypto');
const net = require('net');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

// transforma um socket TCP (handshake já feito) em conexão com eventos
function wrap(socket) {
  const conn = { socket, onmessage: null, onclose: null, alive: true };
  let buf = Buffer.alloc(0);
  let frags = [];

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.slice(off, off + len);
      if (masked) {
        const mask = buf.slice(maskOff, maskOff + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      buf = buf.slice(off + len);
      if (op === 8) { close(); return; }
      if (op === 9) { send(payload, 10); continue; } // ping → pong
      if (op === 10) continue;                        // pong
      frags.push(payload);
      if (fin) {
        const msg = Buffer.concat(frags).toString('utf8');
        frags = [];
        if (conn.onmessage) conn.onmessage(msg);
      }
    }
  });

  function send(data, opcode) {
    if (!conn.alive) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | (opcode || 1), payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | (opcode || 1);
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | (opcode || 1);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    try { socket.write(Buffer.concat([header, payload])); } catch (e) { /* socket fechado */ }
  }

  function close() {
    if (!conn.alive) return;
    conn.alive = false;
    try { socket.end(); } catch (e) { /* já fechado */ }
    if (conn.onclose) conn.onclose();
  }

  socket.on('close', close);
  socket.on('end', close); // sockets do http server ficam em meia-conexão: FIN emite 'end'
  socket.on('error', close);
  conn.send = send;
  conn.close = close;
  return conn;
}

// cliente mínimo (só para os testes automatizados em Node)
function connect(host, port, onopen) {
  const key = crypto.randomBytes(16).toString('base64');
  const conn = { onmessage: null, onclose: null, alive: false };
  let hand = Buffer.alloc(0), done = false, buf = Buffer.alloc(0);

  const sock = net.connect(port, host, () => {
    sock.write(
      `GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    );
  });

  sock.on('data', chunk => {
    if (!done) {
      hand = Buffer.concat([hand, chunk]);
      const idx = hand.indexOf('\r\n\r\n');
      if (idx === -1) return;
      done = true;
      conn.alive = true;
      const rest = hand.slice(idx + 4);
      if (onopen) onopen();
      if (rest.length) handle(rest);
      return;
    }
    handle(chunk);
  });

  function handle(chunk) {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f; // servidor não mascara
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) return;
      const payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (op === 8) {
        conn.alive = false;
        sock.end();
        if (conn.onclose) conn.onclose();
        return;
      }
      if (op === 9 || op === 10) continue;
      if (fin && conn.onmessage) conn.onmessage(payload.toString('utf8'));
    }
  }

  conn.send = data => {
    const payload = Buffer.from(String(data), 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    const maskedPayload = Buffer.from(payload);
    for (let i = 0; i < maskedPayload.length; i++) maskedPayload[i] ^= mask[i % 4];
    try { sock.write(Buffer.concat([header, mask, maskedPayload])); } catch (e) { /* fechado */ }
  };
  conn.close = () => { try { sock.end(); } catch (e) { /* fechado */ } };

  sock.on('close', () => {
    if (conn.alive) {
      conn.alive = false;
      if (conn.onclose) conn.onclose();
    }
  });
  sock.on('error', () => { /* tratado pelo close */ });
  return conn;
}

module.exports = { acceptKey, wrap, connect };
