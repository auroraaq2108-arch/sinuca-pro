// net.js — conexão online do jogo (sala com código) via WebSocket
const NET = (() => {
  let ws = null;
  let connected = false;
  let closing = false;
  const handlers = {};

  // online só funciona quando o jogo é aberto pelo servidor (http), não pelo arquivo
  function available() {
    return location.protocol === 'http:' || location.protocol === 'https:';
  }

  function connect(cb) {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
      if (cb) cb(true);
      return;
    }
    let answered = false;
    try {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      ws = new WebSocket(proto + location.host);
    } catch (e) {
      if (cb) cb(false);
      return;
    }
    ws.onopen = () => {
      connected = true;
      if (!answered && cb) { answered = true; cb(true); }
    };
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (handlers[msg.t]) handlers[msg.t](msg);
    };
    ws.onclose = () => {
      const was = connected;
      connected = false;
      if (!answered && cb) { answered = true; cb(false); }
      if (was && !closing && handlers.drop) handlers.drop({ t: 'drop' });
    };
    ws.onerror = () => { /* onclose cuida */ };
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function on(t, fn) { handlers[t] = fn; }

  function disconnect() {
    closing = true;
    try { if (ws) ws.close(); } catch (e) { /* já fechado */ }
    ws = null;
    connected = false;
    setTimeout(() => { closing = false; }, 200);
  }

  return { available, connect, send, on, disconnect, isOn: () => connected };
})();
