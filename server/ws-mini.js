// ws-mini.js — WebSocket mínimo (RFC 6455) do lado servidor, sem dependências externas.
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 262144; // 256KB por frame — o jogo não manda nada perto disso

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

// transforma um socket TCP (handshake já feito) em conexão com eventos
function wrap(socket) {
  const conn = { socket, onmessage: null, onclose: null, alive: true };
  let buf = Buffer.alloc(0);
  let frags = [];
  let fragsLen = 0;

  socket.on('data', chunk => {
    // teto duro: mesmo antes de decidir se o frame é válido, não deixa o
    // buffer pendente crescer sem limite (um único frame nunca precisa
    // disso — o jogo só troca mensagens JSON pequenas).
    if (buf.length + chunk.length > MAX_FRAME * 2) { close(); return; }
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
      // frame maior que o teto: encerra a conexão já (não espera acumular
      // o corpo inteiro em memória pra só então rejeitar).
      if (len > MAX_FRAME) { close(); return; }
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
      fragsLen += payload.length;
      if (fragsLen > MAX_FRAME) { close(); return; } // mensagem fragmentada crescendo demais
      frags.push(payload);
      if (fin) {
        const msg = Buffer.concat(frags).toString('utf8');
        frags = [];
        fragsLen = 0;
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

module.exports = { acceptKey, wrap };
