// net.js — conexão online do jogo (sala com código / fila) via WebSocket
const NET = (() => {
  let ws = null;
  let connected = false;
  let closing = false;
  let openCbs = [];     // callbacks esperando a conexão abrir
  const handlers = {};

  // online só funciona quando o jogo é aberto pelo servidor (http), não pelo arquivo
  function available() {
    return location.protocol === 'http:' || location.protocol === 'https:';
  }

  function connect(cb) {
    // já aberto: responde na hora
    if (ws && ws.readyState === 1) { if (cb) cb(true); return; }
    // ainda conectando: NÃO responde já (senão o hello/queue são descartados);
    // espera a conexão abrir de verdade
    if (ws && ws.readyState === 0) { if (cb) openCbs.push(cb); return; }

    // cria uma conexão nova
    openCbs = cb ? [cb] : [];
    try {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      ws = new WebSocket(proto + location.host);
    } catch (e) {
      const cbs = openCbs; openCbs = [];
      cbs.forEach(c => c(false));
      return;
    }
    ws.onopen = () => {
      connected = true;
      const cbs = openCbs; openCbs = [];
      cbs.forEach(c => c(true));
    };
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (handlers[msg.t]) handlers[msg.t](msg);
    };
    ws.onclose = () => {
      const was = connected;
      connected = false;
      const cbs = openCbs; openCbs = [];
      cbs.forEach(c => c(false));            // fechou antes de abrir: avisa quem esperava
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
    openCbs = [];
    try { if (ws) ws.close(); } catch (e) { /* já fechado */ }
    ws = null;
    connected = false;
    setTimeout(() => { closing = false; }, 200);
  }

  return { available, connect, send, on, disconnect, isOn: () => connected };
})();
