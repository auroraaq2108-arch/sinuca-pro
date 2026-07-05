// ui.js — telas, moedas de teste, sons, efeito e ligação com o jogo
const UI = (() => {
  const $ = s => document.querySelector(s);
  const RAKE = 0.10; // taxa da plataforma no desafio (10%)
  const APP_VER = 27; // deve bater com o APP_VER do servidor (senão o servidor manda recarregar)
  const BALL_HEX = { 1: '#f6c916', 2: '#2457d6', 3: '#e33131', 4: '#8b2fd6', 5: '#f07f1d', 6: '#1a9e57', 7: '#a12235', 8: '#181818' };

  let coins = parseInt(localStorage.getItem('sinuca_coins') || '500', 10);
  let stats = JSON.parse(localStorage.getItem('sinuca_stats') || '{"w":0,"l":0}');

  // identidade do jogador para o ranking (gerada uma vez por aparelho)
  let myId = localStorage.getItem('sinuca_id');
  if (!myId) {
    myId = 'p' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    localStorage.setItem('sinuca_id', myId);
  }
  let myNick = localStorage.getItem('sinuca_nick') || '';

  // proteção contra apelidos maliciosos exibidos via HTML
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let setupKind = null;   // treino | desafio | 2p
  let lastCfg = null;
  let toastTimer = 0;
  let spinSel = { x: 0, y: 0 };
  let spinDrag = false;

  // ---------- sons (sintetizados, sem arquivos) ----------
  const Sfx = (() => {
    let ac = null, noiseBuf = null, last = 0;
    function ensure() {
      if (!ac) {
        try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* sem áudio */ }
        if (ac) {
          // buffer de ruído branco: base dos estalos realistas
          noiseBuf = ac.createBuffer(1, (ac.sampleRate * 0.25) | 0, ac.sampleRate);
          const d = noiseBuf.getChannelData(0);
          for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        }
      }
      if (ac && ac.state === 'suspended') ac.resume();
    }
    function env(vol, dur) {
      const g = ac.createGain();
      const t = ac.currentTime;
      g.gain.setValueAtTime(Math.min(0.6, Math.max(0.02, vol)), t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      g.connect(ac.destination);
      return g;
    }
    function noise(vol, dur, freq, type, q) {
      const s = ac.createBufferSource();
      s.buffer = noiseBuf;
      s.playbackRate.value = 0.8 + Math.random() * 0.4;
      const f = ac.createBiquadFilter();
      f.type = type || 'bandpass';
      f.frequency.value = freq;
      f.Q.value = q || 0.9;
      s.connect(f);
      f.connect(env(vol, dur));
      const t = ac.currentTime;
      s.start(t);
      s.stop(t + dur + 0.02);
    }
    function tone(freq, vol, dur, type, glide) {
      const o = ac.createOscillator();
      o.type = type || 'sine';
      const t = ac.currentTime;
      o.frequency.setValueAtTime(freq, t);
      if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + dur);
      o.connect(env(vol, dur));
      o.start(t);
      o.stop(t + dur + 0.02);
    }
    function hit(v, kind) {
      const now = performance.now();
      if (kind !== 'pot' && now - last < 28) return;
      last = now;
      if (kind === 'pot' && navigator.vibrate) navigator.vibrate(35);
      if (!ac) return;
      if (kind === 'ball') {
        const vol = Math.min(0.5, v / 1500);
        noise(vol, 0.03, 2400);                          // clique seco de marfim
        tone(1500 + Math.random() * 400, vol * 0.4, 0.02);
        if (v > 850) noise(vol * 0.9, 0.07, 800);        // estalo do break
      } else if (kind === 'cushion') {
        noise(Math.min(0.3, v / 2200), 0.05, 380, 'lowpass');
      } else if (kind === 'pot') {
        tone(320, 0.3, 0.16, 'sine', 130);               // "plop" da caçapa
        noise(0.22, 0.09, 600, 'lowpass');
      }
    }
    // "tim-tim" de alerta (partida encontrada) — toca mesmo sem permissão de notificação
    function ding() {
      try {
        ensure();
        if (!ac) return;
        tone(880, 0.35, 0.18, 'sine');
        setTimeout(() => { if (ac) tone(1318, 0.35, 0.3, 'sine'); }, 150);
      } catch (e) { /* som nunca pode travar o jogo */ }
    }
    return { hit, ensure, ding };
  })();

  // ---------- moedas / estatísticas ----------
  let walletTimer = 0;
  function setCoins(v) {
    coins = Math.max(0, Math.round(v));
    localStorage.setItem('sinuca_coins', String(coins));
    $('#coins').textContent = coins;
    // logado? guarda o saldo na conta (no servidor), sem spam
    if (authToken) {
      clearTimeout(walletTimer);
      walletTimer = setTimeout(() => {
        fetch('/wallet', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: authToken, coins }) }).catch(() => {});
      }, 800);
    }
  }
  function saveStats() {
    localStorage.setItem('sinuca_stats', JSON.stringify(stats));
    $('#stats').textContent = `Vitórias: ${stats.w} · Derrotas: ${stats.l}`;
  }

  // ---------- contas (cadastro / login) ----------
  let account = null;
  let authToken = localStorage.getItem('sinuca_token') || null;
  let authMode = 'register'; // register | login

  function applyAccount(data) {
    account = data.user;
    authToken = data.token;
    localStorage.setItem('sinuca_token', authToken);
    localStorage.setItem('sinuca_email', account.email); // lembra pra não redigitar
    myNick = account.nick;
    localStorage.setItem('sinuca_nick', myNick);
    coins = account.coins;
    localStorage.setItem('sinuca_coins', String(coins));
    $('#coins').textContent = coins;
    showScreen('screen-menu');
  }

  function authError(msg, good) {
    const el = $('#auth-error');
    el.textContent = msg || '';
    el.classList.toggle('ok', !!good);
  }

  function setAuthMode(mode) {
    authMode = mode;
    const reg = mode === 'register';
    $('#auth-nick').classList.toggle('hidden', !reg);
    $('#auth-submit').textContent = reg ? 'CRIAR CONTA' : 'ENTRAR';
    $('#auth-toggle').textContent = reg ? 'já tenho conta — entrar' : 'criar uma conta nova';
    $('#auth-subtitle').textContent = reg
      ? 'Crie sua conta pra jogar e guardar seu progresso'
      : 'Bem-vindo de volta! Entre na sua conta';
    authError('');
  }

  function submitAuth() {
    const email = $('#auth-email').value.trim();
    const password = $('#auth-pass').value;
    const nick = $('#auth-nick').value.trim();
    if (!email || !password) { authError('Preencha email e senha'); return; }
    if (authMode === 'register' && !nick) { authError('Escolha um apelido'); return; }
    authError('conectando…', true);
    $('#auth-submit').disabled = true;
    const path = authMode === 'register' ? '/register' : '/login';
    const body = authMode === 'register' ? { email, password, nick, ref: pendingRef } : { email, password };
    fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(r => r.json().then(j => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        $('#auth-submit').disabled = false;
        if (!ok || j.err) { authError(j.err || 'não deu certo, tente de novo'); return; }
        pendingRef = null;
        applyAccount(j);
      })
      .catch(() => { $('#auth-submit').disabled = false; authError('sem conexão com o servidor'); });
  }

  function logout(keepEmail) {
    localStorage.removeItem('sinuca_token');
    authToken = null;
    account = null;
    // já tem conta antes? volta pro modo LOGIN com o email preenchido (só falta a senha)
    const savedEmail = localStorage.getItem('sinuca_email') || '';
    setAuthMode(savedEmail ? 'login' : 'register');
    $('#auth-email').value = keepEmail === false ? '' : savedEmail;
    $('#auth-pass').value = '';
    showScreen('screen-auth');
  }

  // link de indicação recebido na URL (?ref=CODE)
  let pendingRef = null;
  (function () {
    const m = (location.search || '').match(/[?&]ref=([A-Za-z0-9]{4,8})/);
    if (m) pendingRef = m[1].toUpperCase();
  })();

  // ao abrir: tenta entrar com o token salvo; senão mostra cadastro/login
  function bootAuth() {
    if (!NET.available()) {
      // aberto pelo arquivo (sem servidor): joga offline, sem conta
      showScreen('screen-menu');
      return;
    }
    if (authToken) {
      fetch('/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: authToken }) })
        .then(r => r.json().then(j => ({ ok: r.ok, j })))
        .then(({ ok, j }) => {
          if (ok && !j.err) applyAccount(j);        // login automático!
          else { logout(); authError('Sua sessão expirou — entre de novo.'); }
        })
        .catch(() => { showScreen('screen-menu'); }); // servidor fora do ar: entra offline
    } else {
      const savedEmail = localStorage.getItem('sinuca_email') || '';
      setAuthMode(savedEmail && !pendingRef ? 'login' : 'register');
      $('#auth-email').value = savedEmail;
      if (pendingRef) authError('🤝 Você foi convidado! Crie sua conta.', true);
      showScreen('screen-auth');
    }
  }

  // ---------- telas ----------
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(el => el.classList.toggle('hidden', el.id !== id));
  }
  function toast(msg, ms, ballN) {
    displayToast(msg, ms, ballN);
    // online: quem resolve a jogada repassa a mensagem pro outro aparelho
    if (typeof NET !== 'undefined' && Game.isNetAuth && Game.isNetAuth()) {
      NET.send({ t: 'toast', m: msg, ms, ball: ballN });
    }
  }
  function displayToast(msg, ms, ballN) {
    const el = $('#toast');
    if (ballN != null) {
      const c = BALL_HEX[ballN > 8 ? ballN - 8 : ballN];
      const bg = ballN > 8
        ? `linear-gradient(180deg,#f4f1e8 0 22%,${c} 22% 78%,#f4f1e8 78% 100%)`
        : c;
      el.innerHTML = '';
      el.append(msg);
      el.insertAdjacentHTML('beforeend', `<span class="toast-ball" style="background:${bg}"><i>${ballN}</i></span>`);
    } else {
      el.textContent = msg;
    }
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms || 2400);
  }

  // ---------- configuração da partida ----------
  function openSetup(kind) {
    setupKind = kind;
    $('#setup-title').textContent =
      kind === 'treino' ? '🎯 Treinamento vs Bot' :
      kind === 'desafio' ? '💰 Desafio de Moedas' : '👥 2 Jogadores';
    $('#opt-level').classList.toggle('hidden', kind === '2p');
    $('#opt-stake').classList.toggle('hidden', kind !== 'desafio');
    $('#stake-info').classList.toggle('hidden', kind !== 'desafio');
    // formato sugerido: desafio começa em série, treino/2p em jogo único
    selectSeg('opt-format', kind === 'desafio' ? '3' : '1');
    refreshFormatLabels(segValue('opt-mode') === 'tresbolas');
    showScreen('screen-setup');
  }

  function selectSeg(groupId, v) {
    document.querySelectorAll(`#${groupId} .seg button`).forEach(b =>
      b.classList.toggle('sel', b.dataset.v === String(v)));
  }

  // no 3 bolas o formato vira corrida de vitórias (até 5 / até 15)
  function refreshFormatLabels(tres) {
    const btns = document.querySelectorAll('#opt-format .seg button');
    if (btns.length < 3) return;
    btns[1].textContent = tres ? 'Até 5' : 'Melhor de 3';
    btns[2].textContent = tres ? 'Até 15' : 'Melhor de 5';
  }

  function segValue(groupId) {
    const el = document.querySelector(`#${groupId} .seg .sel`);
    return el ? el.dataset.v : null;
  }

  function buildCfg() {
    const stake = setupKind === 'desafio' ? parseInt(segValue('opt-stake'), 10) : 0;
    const mode = segValue('opt-mode') || '8ball';
    const v = parseInt(segValue('opt-format') || '1', 10);
    // 3 bolas: os mesmos botões viram corrida até 5 (=9 jogos) / até 15 (=29 jogos)
    const bestOf = mode === 'tresbolas' ? ({ 1: 1, 3: 9, 5: 29 })[v] : v;
    return {
      mode,
      p2: setupKind === '2p' ? 'human' : 'bot',
      level: segValue('opt-level') || 'medio',
      stake,
      bestOf,
      breaker: 0,
    };
  }

  // texto do formato: "Melhor de 3" ou "Corrida até 5"
  function fmtSerie(mode, bestOf) {
    if (!bestOf || bestOf <= 1) return '';
    const target = Math.ceil(bestOf / 2);
    return mode === 'tresbolas' ? `Corrida até ${target}` : `Melhor de ${bestOf}`;
  }

  // celular: entra em tela cheia pra esconder a barra do navegador (Android)
  function goFullscreen() {
    try {
      if (matchMedia('(pointer: coarse)').matches && !document.fullscreenElement &&
          document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    } catch (e) { /* navegador não deixa, segue o jogo */ }
  }

  function startMatch(cfg) {
    goFullscreen();
    keepAwake();
    if (cfg.stake > 0) {
      if (coins < cfg.stake) {
        toast('Moedas insuficientes! Use o +500 no menu.');
        return;
      }
      setCoins(coins - cfg.stake); // aposta vai para o "escrow"
    }
    lastCfg = { ...cfg };
    spinSel = { x: 0, y: 0 };
    $('#overlay-end').classList.add('hidden');
    $('#pbox0 .avatar').textContent = '😎';
    $('#pbox1 .avatar').textContent = cfg.p2 === 'human' ? '🧢' : '🤖';
    showScreen('screen-game');
    Game.start(cfg);
    refreshHud();
  }

  // ---------- fim de jogo da série (a série continua) ----------
  let seriesPending = false;

  function gameEnded(winner, reason, match) {
    seriesPending = true;
    const w = match.players[winner];
    $('#end-title').textContent = `${winner === 0 ? '🎉' : '🎱'} ${w.name} venceu o jogo ${match.gameNum}`;
    $('#end-reason').textContent = reason || '';
    const target = Math.ceil(match.bestOf / 2);
    const lines = [
      `<b>${esc(match.players[0].name)} ${match.wins[0]} × ${match.wins[1]} ${esc(match.players[1].name)}</b>`,
      `${fmtSerie(match.mode, match.bestOf)} — primeiro a vencer ${target} jogos leva${match.stake > 0 ? ' o pote' : ''}.`,
    ];
    $('#end-lines').innerHTML = lines.map(l => `<div>${l}</div>`).join('');
    $('#btn-rematch').textContent = 'PRÓXIMO JOGO ▶';
    $('#overlay-end').classList.remove('hidden');
  }

  // ---------- fim de partida / série ----------
  function matchEnded(winner, reason, match) {
    seriesPending = false;
    $('#btn-rematch').textContent = 'REVANCHE'; $('#btn-rematch').classList.remove('hidden');
    const localSeat = match.localSeat || 0;
    const p2bot = match.players[1].type === 'bot';
    const vsRemote = match.players[1 - localSeat].type === 'remote';
    const youWon = winner === localSeat;
    let title;
    if (!p2bot && !vsRemote) title = `🏆 ${match.players[winner].name} venceu!`;
    else title = youWon ? '🏆 Você venceu!' : '😞 Você perdeu…';
    $('#end-title').textContent = title;
    $('#end-reason').textContent = reason || '';

    const lines = [];
    if (match.bestOf > 1) {
      lines.push(`<b>Série: ${esc(match.players[0].name)} ${match.wins[0]} × ${match.wins[1]} ${esc(match.players[1].name)}</b>`);
    }
    if (match.stake > 0) {
      // taxa de 10% incide SÓ sobre o ganho — extrato curto, sem poluição
      const gain = Math.round(match.stake * (1 - RAKE));
      const prize = match.stake + gain;
      if (youWon) {
        setCoins(coins + prize);
        lines.push(`<b class="prize-line">+ 💰 ${prize}</b>`);
      } else {
        lines.push(`<b class="prize-line lose">− 💰 ${match.stake}</b>`);
      }
      lines.push(`Saldo: 💰 ${coins}`);
    }
    $('#end-lines').innerHTML = lines.map(l => `<div>${l}</div>`).join('');

    if (p2bot || vsRemote) {
      if (youWon) stats.w++; else stats.l++;
      saveStats();
    }
    // ranking: o anfitrião reporta o resultado da partida online
    if (vsRemote && online.active && online.seat === 0) {
      NET.send({ t: 'result', w: winner });
    }
    if (vsRemote) online.settled = true; // aposta paga: fuga depois daqui não dá pote
    $('#overlay-end').classList.remove('hidden');
  }

  // ---------- HUD ----------
  function miniBall(n, dim) {
    const c = BALL_HEX[n > 8 ? n - 8 : n];
    const bg = n > 8
      ? `linear-gradient(180deg,#f4f1e8 0 22%,${c} 22% 78%,#f4f1e8 78% 100%)`
      : c;
    return `<span class="mini${dim ? ' dim' : ''}" style="background:${bg}"></span>`;
  }

  let wasMyTurn = false;
  function refreshHud() {
    const hud = Game.getHud();
    if (!hud) return;
    // chegou a sua vez com o jogo minimizado? avisa antes do relógio comer
    const myTurn = !!hud.online && hud.humanCanAct;
    if (myTurn && !wasMyTurn) notify('Sua vez de jogar!', 'O relógio de 1 minuto já está correndo — volta lá!');
    wasMyTurn = myTurn;
    for (let i = 0; i < 2; i++) {
      const box = $(`#pbox${i}`);
      const p = hud.players[i];
      box.querySelector('.pname').textContent = hud.online && i === hud.localSeat ? `${p.name} (você)` : p.name;
      box.querySelector('.pinfo').textContent = p.info;
      const tray = box.querySelector('.tray');
      const GROUP_NUMS = {
        solid: [1, 2, 3, 4, 5, 6, 7],
        stripe: [9, 10, 11, 12, 13, 14, 15],
      };
      if (p.group && GROUP_NUMS[p.group]) {
        tray.innerHTML = GROUP_NUMS[p.group].map(n => miniBall(n, !p.balls.includes(n))).join('');
      } else {
        tray.innerHTML = '';
      }
      box.classList.toggle('active', hud.current === i && hud.state !== 'over');
    }
    let mid = hud.mode === '8ball' ? '8 BALL' : hud.mode === '9ball' ? '9 BALL' : '3 BOLAS';
    if (hud.stake > 0) mid += ` · 💰 ${hud.stake}`;
    $('#mode-badge').textContent = mid;
    const sb = $('#series-badge');
    if (hud.bestOf > 1) {
      sb.textContent = `${hud.stake >= 1000 ? '⭐ PRO · ' : ''}${fmtSerie(hud.mode, hud.bestOf)} · ${hud.wins[0]} × ${hud.wins[1]}`;
      sb.classList.remove('hidden');
    } else {
      sb.classList.add('hidden');
    }
    const midTray = $('#mid-tray');
    if (hud.nine) {
      midTray.innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9]
        .map(n => miniBall(n, !hud.nine.includes(n))).join('');
    } else if (hud.three) {
      midTray.innerHTML = [1, 2, 3]
        .map(n => miniBall(n, !hud.three.includes(n))).join('');
    } else {
      midTray.innerHTML = '';
    }
  }

  function refreshControls() {
    const hud = Game.getHud();
    const can = !!hud && hud.humanCanAct && hud.state === 'aim';
    $('#btn-shoot').disabled = !can;
    $('#aim-left').disabled = !can;
    $('#aim-right').disabled = !can;
    $('#power-wrap').classList.toggle('pw-off', !can);
    $('#btn-spin').disabled = !can;
    $('#btn-chat').classList.toggle('hidden', !(hud && hud.online)); // chat só online
    // indicador de efeito no botão
    const s = Game.getSpin ? Game.getSpin() : { x: 0, y: 0 };
    const ind = $('#spin-indicator');
    ind.style.transform = `translate(${s.x * 8}px, ${-s.y * 8}px)`;
    ind.classList.toggle('on', s.x !== 0 || s.y !== 0);
  }

  // ---------- efeito (spin) ----------
  function openSpin() {
    const cur = Game.getSpin();
    spinSel = { x: cur.x, y: cur.y };
    placeSpinDot();
    $('#overlay-spin').classList.remove('hidden');
  }
  function placeSpinDot() {
    const ball = $('#spin-ball');
    const r = ball.clientWidth / 2;
    const dot = $('#spin-dot');
    dot.style.left = `${r + spinSel.x * r * 0.68 - dot.clientWidth / 2}px`;
    dot.style.top = `${r - spinSel.y * r * 0.68 - dot.clientHeight / 2}px`;
  }
  function spinFromEvent(e) {
    const ball = $('#spin-ball');
    const rect = ball.getBoundingClientRect();
    const r = rect.width / 2;
    let x = (e.clientX - rect.left - r) / (r * 0.68);
    let y = -(e.clientY - rect.top - r) / (r * 0.68);
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    spinSel = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
    placeSpinDot();
  }

  // ---------- notificações (avisa mesmo com o jogo minimizado) ----------
  let swReg = null;
  const baseTitle = document.title;
  if ('serviceWorker' in navigator && NET.available()) {
    navigator.serviceWorker.register('sw.js').then(r => { swReg = r; }).catch(() => { /* sem suporte */ });
  }
  function askNotif() {
    try {
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    } catch (e) { /* sem suporte */ }
  }
  function notify(title, body) {
    if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
    if (!document.hidden) return; // com o jogo na tela, o aviso normal resolve
    document.title = '🎱 ' + title;
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        if (swReg && swReg.showNotification) {
          swReg.showNotification('Sinuca Pro — ' + title, { body, tag: 'sinuca-pro', renotify: true, vibrate: [100, 50, 100] });
        } else {
          new Notification('Sinuca Pro — ' + title, { body });
        }
      }
    } catch (e) { /* navegador não deixa */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) document.title = baseTitle;
  });

  // ---------- tela sempre acesa durante partida/fila (Wake Lock) ----------
  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { /* navegador não deixa, segue */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (online.active || queueing)) keepAwake();
  });

  // ---------- jogar online (sala com senha ou fila rápida) ----------
  const online = { active: false, seat: 0, lastBreaker: 0, waiting: false, mode: '8ball', bestOf: 1, stake: 0, oppName: '', settled: true };
  let queueing = false;      // está na fila?
  let lastQueue = null;      // preferências da última fila (pra re-entrar após queda)
  let reconTries = 0;        // tentativas de reconexão

  // conecta e se identifica no servidor (apelido + id do ranking + versão)
  // com timeout: se não abrir em 15s (servidor grátis dormindo/rede ruim), avisa
  function ensureHello(cb) {
    let done = false;
    const to = setTimeout(() => {
      if (done) return;
      done = true;
      netDebug('conexão demorou');
      cb(false);
    }, 15000);
    NET.connect(ok => {
      if (done) return;
      done = true;
      clearTimeout(to);
      if (!ok) { netDebug('conexão falhou'); cb(false); return; }
      const el = $('#nick');
      const digitado = el && el.value.trim() ? el.value.trim() : myNick;
      myNick = (digitado || 'Jogador').slice(0, 14);
      localStorage.setItem('sinuca_nick', myNick);
      NET.send({ t: 'hello', id: myId, name: myNick, v: APP_VER });
      netDebug('conectado');
      cb(true);
    });
  }

  // linha de diagnóstico (ajuda a achar onde trava no celular)
  let lastEvt = '—';
  function netDebug(evt) {
    if (evt) lastEvt = evt;
    const el = $('#net-debug');
    if (el) el.textContent = `📡 ${NET.isOn() ? 'conectado' : 'desligado'} · ${lastEvt} · v${APP_VER}`;
  }
  setInterval(() => { if (!$('#screen-online').classList.contains('hidden')) netDebug(); }, 1500);

  function onlineStatus(msg, big) {
    const el = $('#online-status');
    // sala criada: esconde o formulário e mostra só o código, grandão
    document.querySelector('.online-box').classList.toggle('hidden', !!big);
    el.innerHTML = big
      ? `Passe esta senha pro seu amigo:<div class="room-code-big">${esc(big)}</div>Esperando ele entrar…`
      : msg;
  }

  function openOnline(stakeDefault, freeMode) {
    if (!NET.available()) {
      displayToast('Pra jogar online, abra o jogo pelo link do servidor (veja o LEIA-ME)', 5000);
      return;
    }
    online.freeMode = !!freeMode; // amistoso: sem aposta nenhuma
    $('#online-title').textContent = freeMode ? '🌐 Amistoso — sem aposta' : '💵 Jogar Valendo';
    $('#opt-online-stake').classList.toggle('hidden', !!freeMode);
    onlineStatus('');
    document.querySelector('.online-box').classList.remove('hidden');
    $('#room-code').value = '';
    $('#nick').value = myNick;
    $('#btn-cancel-queue').classList.add('hidden');
    if (!freeMode && stakeDefault != null) selectSeg('opt-online-stake', stakeDefault);
    showScreen('screen-online');
  }

  function onlineBegin(seat, ballsArr, breaker, bestOf, mode, names, stake) {
    goFullscreen();
    keepAwake(); // tela não apaga no meio da partida valendo
    online.active = true;
    online.seat = seat;
    online.lastBreaker = breaker;
    online.waiting = false;
    online.mode = mode || '8ball';
    online.stake = stake || 0;
    online.settled = online.stake === 0;
    seriesPending = false;
    // a aposta sai da carteira na entrada (escrow) — volta em dobro (menos a taxa) se vencer
    if (online.stake > 0) setCoins(coins - online.stake);
    $('#btn-rematch').textContent = 'REVANCHE'; $('#btn-rematch').classList.remove('hidden');
    $(`#pbox${seat} .avatar`).textContent = '😎';
    $(`#pbox${1 - seat} .avatar`).textContent = '🧑';
    $('#overlay-end').classList.add('hidden');
    showScreen('screen-game');
    Game.start({
      mode: online.mode,
      p2: 'online',
      online: { seat },
      balls: ballsArr,
      breaker,
      stake: online.stake,
      bestOf: bestOf || 1,
      names,
    });
    refreshHud();
  }

  // anfitrião (assento 0) monta a mesa e manda pro convidado
  function hostStart(breaker) {
    if (online.stake > 0 && coins < online.stake) {
      // não deixa o convidado travado esperando: cancela a partida limpo
      NET.send({ t: 'bye' });
      onlineQuit('Você não tinha moedas suficientes — partida cancelada.');
      return;
    }
    const rackBalls = Game.makeRack(online.mode);
    const names = [myNick || 'Jogador 1', online.oppName || 'Jogador 2'];
    NET.send({ t: 'start', balls: rackBalls, breaker, bestOf: online.bestOf || 1, mode: online.mode, names, stake: online.stake });
    onlineBegin(0, rackBalls, breaker, online.bestOf || 1, online.mode, names, online.stake);
  }

  // próximo jogo da série online: anfitrião monta a mesa nova pros dois
  function hostNextGame() {
    const rackBalls = Game.makeRack(online.mode);
    NET.send({ t: 'nextgame', balls: rackBalls });
    seriesPending = false;
    online.waiting = false;
    $('#btn-rematch').textContent = 'REVANCHE'; $('#btn-rematch').classList.remove('hidden');
    $('#overlay-end').classList.add('hidden');
    Game.nextGameOnline(rackBalls);
  }

  function onlineQuit(msg, walkover) {
    const inGame = online.active;
    const hud = Game.getHud();
    const gameOver = hud && hud.state === 'over'; // já acabou normalmente? não mostra 2ª vez
    queueing = false;
    // adversário abandonou uma partida em andamento? mostra tela de VITÓRIA pra quem ficou
    const winByAbandon = walkover && inGame && !gameOver;
    let prize = 0;
    if (winByAbandon) {
      // paga o pote só se valendo e ainda não pago (evita pagar duas vezes)
      if (online.stake > 0 && !online.settled) {
        const gain = Math.round(online.stake * (1 - RAKE));
        prize = online.stake + gain; // sua aposta de volta + 90% da dele
        setCoins(coins + prize);
        online.settled = true;
      }
      stats.w++; saveStats();
    }
    online.active = false;
    online.waiting = false;
    // saída voluntária: manda 'bye' e MANTÉM a conexão aberta (se desconectasse na hora,
    // o 'bye' se perdia na corrida com o fechamento e o adversário via "caiu" em vez de "abandonou")
    if (NET.isOn()) NET.send({ t: 'bye' });
    Game.stop();

    if (winByAbandon) {
      // tela de vitória, igual a ganhar a partida
      seriesPending = false;
      $('#btn-rematch').classList.add('hidden');
      $('#end-title').textContent = '🏆 Você venceu!';
      $('#end-reason').textContent = 'O adversário abandonou a partida.';
      const lines = [];
      if (prize > 0) {
        lines.push(`<b class="prize-line">+ 💰 ${prize}</b>`);
        lines.push(`Saldo: 💰 ${coins}`);
      }
      $('#end-lines').innerHTML = lines.map(l => `<div>${l}</div>`).join('');
      $('#overlay-end').classList.remove('hidden');
    } else if (inGame) {
      $('#overlay-end').classList.add('hidden');
      showScreen('screen-menu');
      if (msg) displayToast(msg, 5500);
    } else if (msg) {
      document.querySelector('.online-box').classList.remove('hidden');
      onlineStatus(msg);
    }
  }

  function bindOnline() {
    $('#btn-online').addEventListener('click', () => openOnline(null, true)); // amistoso: sem aposta
    $('#btn-valendo').addEventListener('click', () => openOnline('100', false));
    $('#btn-online-back').addEventListener('click', () => { onlineQuit(); showScreen('screen-menu'); });
    $('#btn-ranking').addEventListener('click', openRanking);
    $('#btn-ranking-back').addEventListener('click', () => showScreen('screen-menu'));
    $('#rotate-hint').addEventListener('click', () => $('#rotate-hint').classList.add('off'));

    function readOnlineFormat() {
      online.mode = segValue('opt-online-mode') || '8ball';
      const v = parseInt(segValue('opt-online-bestof') || '1', 10);
      // 3 bolas: os botões viram corrida até 5 / até 15
      online.bestOf = online.mode === 'tresbolas' ? ({ 1: 1, 3: 9, 5: 29 })[v] : v;
      online.stake = online.freeMode ? 0 : parseInt(segValue('opt-online-stake') || '10', 10);
    }

    // tem moedas suficientes pra aposta escolhida?
    function stakeOk() {
      if (online.stake > 0 && coins < online.stake) {
        onlineStatus(`⚠ Moedas insuficientes pra valer 💰 ${online.stake} — seu saldo: 💰 ${coins}. Pegue +500 no menu.`);
        return false;
      }
      return true;
    }

    $('#btn-create-room').addEventListener('click', () => {
      askNotif(); // pede permissão de notificação (clique do usuário é a hora certa)
      const want = $('#create-code').value.trim();
      readOnlineFormat();
      if (!stakeOk()) return;
      onlineStatus('Conectando… (a primeira conexão pode levar alguns segundos)');
      ensureHello(ok => {
        if (!ok) { onlineStatus('⚠ O servidor demorou a responder (ele "dorme" quando ninguém joga). Toque em Criar sala de novo.'); return; }
        NET.send({ t: 'create', code: want, stake: online.stake });
      });
    });

    // fila rápida: pareia com quem escolheu a mesma modalidade E mesma aposta
    $('#btn-quick').addEventListener('click', () => {
      askNotif();
      readOnlineFormat();
      if (!stakeOk()) return;
      onlineStatus('Conectando… (a primeira conexão pode levar alguns segundos)');
      netDebug('conectando');
      lastQueue = { mode: online.mode, bestOf: online.bestOf, stake: online.stake };
      ensureHello(ok => {
        if (!ok) { onlineStatus('⚠ O servidor demorou a responder (ele "dorme" quando ninguém joga). Toque em Entrar na fila de novo.'); return; }
        netDebug('enviando fila');
        NET.send({ t: 'queue', ...lastQueue });
      });
    });
    $('#btn-cancel-queue').addEventListener('click', () => {
      NET.send({ t: 'unqueue' });
      queueing = false;
      $('#btn-cancel-queue').classList.add('hidden');
      onlineStatus('Busca cancelada.');
    });

    // rótulos do formato mudam conforme a modalidade escolhida
    document.querySelectorAll('#opt-online-mode .seg button').forEach(b =>
      b.addEventListener('click', () => {
        const tres = b.dataset.v === 'tresbolas';
        const btns = document.querySelectorAll('#opt-online-bestof .seg button');
        btns[1].textContent = tres ? 'Até 5' : 'Melhor de 3';
        btns[2].textContent = tres ? 'Até 15' : 'Melhor de 5';
      }));

    $('#btn-join-room').addEventListener('click', () => {
      const code = $('#room-code').value.trim().toUpperCase();
      if (code.length < 3) { onlineStatus('Digite a senha da sala (3 a 8 letras/números).'); return; }
      onlineStatus('Conectando… (a primeira conexão pode levar alguns segundos)');
      ensureHello(ok => {
        if (!ok) { onlineStatus('Servidor não encontrado. Abra o jogo pelo link do servidor.'); return; }
        NET.send({ t: 'join', code });
      });
    });

    // servidor avisou que este jogo está numa versão velha: recarrega uma vez
    NET.on('reload', () => {
      if (sessionStorage.getItem('sinuca_reloaded') === String(APP_VER)) {
        // já recarreguei e ainda veio velho: cache teimoso, avisa em vez de virar loop
        displayToast('⚠ Feche e reabra o jogo (o navegador está segurando uma versão antiga).', 8000);
        return;
      }
      sessionStorage.setItem('sinuca_reloaded', String(APP_VER));
      displayToast('Atualizando o jogo…', 2000);
      setTimeout(() => location.reload(), 400);
    });

    // mensagens do servidor
    NET.on('created', m => onlineStatus('', m.code));
    NET.on('err', m => onlineStatus('⚠ ' + m.m));
    NET.on('joined', m => {
      const stake = m.stake || 0;
      if (stake > 0 && coins < stake) {
        NET.disconnect();
        document.querySelector('.online-box').classList.remove('hidden');
        onlineStatus(`⚠ Essa sala está valendo 💰 ${stake} e seu saldo é 💰 ${coins}. Pegue +500 no menu.`);
        return;
      }
      online.stake = stake;
      online.oppName = m.name || '';
      onlineStatus(stake > 0
        ? `Conectado! Sala valendo 💰 ${stake}. Esperando o anfitrião começar…`
        : 'Conectado! Esperando o anfitrião começar…');
    });
    NET.on('peer', m => {
      online.oppName = m.name || '';
      notify('Adversário entrou!', `${m.name || 'Um jogador'} entrou na sua sala — a partida vai começar`);
      hostStart(0);
    });
    NET.on('queued', m => {
      queueing = true;
      keepAwake();
      netDebug('na fila, esperando');
      const s = m.stake > 0 ? ` valendo 💰 ${m.stake}` : '';
      onlineStatus(`🎱 Você está na fila${s}! Assim que outro jogador entrar, a partida começa automaticamente (fica de olho pra não perder no tempo).`);
      $('#btn-cancel-queue').classList.remove('hidden');
    });

    // achou adversário: os dois precisam ACEITAR em 20s
    let acceptTimer = null;
    let foundTimer = null;
    let acceptCtx = 'queue'; // 'queue' = fila · 'rematch' = convite de revanche
    NET.on('found', m => {
      acceptCtx = 'queue';
      Sfx.ding();
      notify('Partida encontrada!', `${m.name || 'Um jogador'} topa jogar${m.stake ? ` valendo 💰 ${m.stake}` : ''} — toca pra aceitar!`);
      $('#accept-info').innerHTML =
        `<b>${esc(m.name || 'Jogador')}</b> topa jogar ${m.mode === 'tresbolas' ? '3 Bolas' : '8 Ball'}` +
        `${m.stake ? ` valendo <b>💰 ${m.stake}</b>` : ' (amistoso)'}`;
      $('#overlay-accept').classList.remove('hidden');
      $('#btn-accept').disabled = false;
      let secs = 20;
      clearInterval(acceptTimer);
      $('#accept-count').textContent = `${secs}s pra aceitar`;
      acceptTimer = setInterval(() => {
        secs--;
        $('#accept-count').textContent = secs > 0 ? `${secs}s pra aceitar` : 'tempo esgotado…';
        if (secs <= 0) clearInterval(acceptTimer);
      }, 1000);
    });
    NET.on('nomatch', m => {
      clearInterval(acceptTimer);
      $('#overlay-accept').classList.add('hidden');
      queueing = !!m.requeued;
      $('#btn-cancel-queue').classList.toggle('hidden', !m.requeued);
      onlineStatus((m.requeued ? '🎱 De volta à fila — ' : '⚠ ') + m.m);
    });
    NET.on('waitaccept', () => {
      $('#btn-accept').disabled = true;
      $('#accept-info').innerHTML += '<br>✔ Você aceitou — esperando o adversário…';
    });
    $('#btn-accept').addEventListener('click', () => {
      if (acceptCtx === 'rematch') {
        $('#overlay-accept').classList.add('hidden');
        if (online.seat === 0) hostStart(1 - online.lastBreaker);
        else {
          NET.send({ t: 'again-ok' });
          $('#end-reason').textContent = 'Revanche aceita — montando a mesa…';
        }
        return;
      }
      NET.send({ t: 'accept' });
    });
    $('#btn-decline').addEventListener('click', () => {
      clearInterval(acceptTimer);
      $('#overlay-accept').classList.add('hidden');
      if (acceptCtx === 'rematch') NET.send({ t: 'again-no' });
      else NET.send({ t: 'decline' });
    });

    NET.on('matched', m => {
      clearInterval(acceptTimer);
      $('#overlay-accept').classList.add('hidden');
      $('#btn-cancel-queue').classList.add('hidden');
      queueing = false;
      online.mode = m.mode;
      online.bestOf = m.bestOf || 1;
      online.stake = m.stake || 0;
      online.oppName = m.name || '';
      netDebug('ACHOU! vs ' + (m.name || '?'));
      // CRÍTICO PRIMEIRO: inicia a partida (nada cosmético pode travar isto)
      if (m.seat === 0) hostStart(0);
      else onlineStatus(`🎱 Adversário encontrado: ${m.name || 'Jogador'} — começando…`);
      // cosmético depois (som/notificação/confirmação), isolado de erros
      try {
        Sfx.ding();
        notify('Partida encontrada!', `Jogando contra ${m.name || 'Jogador'}${m.stake ? ` valendo 💰 ${m.stake}` : ''}`);
        $('#found-name').textContent = m.name || 'Jogador';
        $('#found-info').textContent = (m.mode === 'tresbolas' ? '3 Bolas' : '8 Ball') +
          (m.stake ? ` · valendo 💰 ${m.stake}` : ' · amistoso');
        $('#overlay-found').classList.remove('hidden');
        clearTimeout(foundTimer);
        foundTimer = setTimeout(() => $('#overlay-found').classList.add('hidden'), 2600);
      } catch (e) { /* enfeite não pode travar a partida */ }
    });
    NET.on('pts', m => {
      if (m.delta != null) {
        displayToast(`🏆 Ranking: ${m.delta > 0 ? '+' : ''}${m.delta} pontos (total: ${m.pts})`, 5000);
      }
    });
    NET.on('top', m => renderTop(m));

    // letreiro de vitórias no menu (prova social)
    const showFeed = item => {
      const el = $('#feed-line');
      if (!el || !item) return;
      el.innerHTML = `🏆 <b>${esc(item.w)}</b> acabou de ganhar <b>💰 ${item.v}</b> de ${esc(item.l)}`;
      el.classList.add('on');
    };
    NET.on('feed', m => showFeed(m.item));
    NET.on('feedlist', m => showFeed(m.list[m.list.length - 1]));
    NET.on('start', m => onlineBegin(1, m.balls, m.breaker, m.bestOf, m.mode, m.names, m.stake));
    NET.on('nextgame', m => {
      seriesPending = false;
      online.waiting = false;
      $('#btn-rematch').textContent = 'REVANCHE'; $('#btn-rematch').classList.remove('hidden');
      $('#overlay-end').classList.add('hidden');
      Game.nextGameOnline(m.balls);
    });
    NET.on('nextreq', () => { if (online.seat === 0 && seriesPending) hostNextGame(); });

    // convite de revanche: o outro lado decide
    NET.on('again', () => {
      if (online.waiting) {
        // os dois pediram revanche ao mesmo tempo: fecha o acordo direto
        if (online.seat === 0) hostStart(1 - online.lastBreaker);
        else NET.send({ t: 'again-ok' });
        return;
      }
      Sfx.ding();
      acceptCtx = 'rematch';
      $('#accept-info').innerHTML = `<b>${esc(online.oppName || 'O adversário')}</b> quer revanche${online.stake ? ` valendo <b>💰 ${online.stake}</b>` : ''}!`;
      $('#accept-count').textContent = '';
      $('#btn-accept').disabled = false;
      $('#overlay-accept').classList.remove('hidden');
    });
    NET.on('again-ok', () => { if (online.seat === 0) hostStart(1 - online.lastBreaker); });
    NET.on('again-no', () => {
      online.waiting = false;
      $('#end-reason').textContent = 'O adversário recusou a revanche.';
      displayToast('Revanche recusada.', 3500);
    });
    // pediu revanche mas o adversário já tinha ido embora: encerra a sala
    NET.on('alone', () => onlineQuit('O adversário já saiu — sala encerrada.'));
    NET.on('left', () => onlineQuit('O adversário saiu da partida.', true));

    // conexão caiu (tela bloqueou, trocou de app): NÃO desiste — reconecta e volta pro jogo
    NET.on('drop', () => {
      netDebug('conexão caiu');
      if ((online.active && !online.settled) || queueing) {
        displayToast('📶 Conexão caiu — reconectando…', 4000);
        reconTries = 0;
        tryReconnect();
      } else if (online.active) {
        onlineQuit('Conexão perdida.');
      }
    });
    function tryReconnect() {
      if (!online.active && !queueing) return;
      if (++reconTries > 14) {
        queueing = false;
        onlineQuit('Não consegui reconectar — verifique a internet.');
        return;
      }
      NET.connect(ok => {
        if (!ok) { setTimeout(tryReconnect, 3000); return; }
        NET.send({ t: 'hello', id: myId, name: myNick }); // dispara a retomada no servidor
        if (queueing && lastQueue) NET.send({ t: 'queue', ...lastQueue }); // volta pra fila
      });
    }
    NET.on('resumed', () => {
      displayToast('📶 Reconectado! Sincronizando a mesa…', 3500);
      NET.send({ t: 'syncreq' }); // pede o estado atual pra quem ficou
    });
    NET.on('peer-off', () => displayToast('📶 O adversário caiu — esperando ele voltar (até 45s)…', 6000));
    NET.on('peer-back', () => { displayToast('📶 Adversário reconectou!', 3000); Game.resumeShare(); });
    NET.on('syncreq', () => Game.resumeShare());

    // mensagens do jogo (repassadas pelo servidor)
    NET.on('shot', m => Game.netShot(m));
    NET.on('snap', m => Game.netSnap(m));
    NET.on('sync', m => Game.netSync(m));
    NET.on('place', m => Game.netPlace(m));
    NET.on('aim', m => Game.netAim(m));
    NET.on('end', m => Game.netEnd(m));
    NET.on('toast', m => displayToast(m.m, m.ms, m.ball));
    NET.on('again', () => { if (online.seat === 0) hostStart(1 - online.lastBreaker); });
  }

  // ---------- ranking ----------
  function renderTop(m) {
    const el = $('#ranking-list');
    if (!m.list || !m.list.length) {
      el.innerHTML = '<div class="rk-empty">Ninguém no ranking ainda — jogue online pra pontuar!</div>';
    } else {
      el.innerHTML = m.list.map((p, i) =>
        `<div class="rk-row${i === 0 ? ' rk-first' : ''}">` +
        `<span class="rk-pos">${i + 1}º</span>` +
        `<span class="rk-name">${esc(p.name)}</span>` +
        `<span class="rk-rec">${p.w}V ${p.l}D</span>` +
        `<b class="rk-pts">${p.pts}</b></div>`).join('');
    }
    $('#ranking-me').textContent = m.me
      ? `Você (${m.me.name}): ${m.me.pts} pontos · ${m.me.w}V ${m.me.l}D`
      : 'Jogue online pra entrar no ranking!';
  }

  function openRanking() {
    if (!NET.available()) {
      displayToast('O ranking fica no servidor — abra o jogo pelo link do servidor.', 5000);
      return;
    }
    $('#ranking-list').innerHTML = '<div class="rk-empty">Carregando…</div>';
    $('#ranking-me').textContent = '';
    showScreen('screen-ranking');
    ensureHello(ok => {
      if (!ok) { $('#ranking-list').innerHTML = '<div class="rk-empty">Servidor não encontrado.</div>'; return; }
      NET.send({ t: 'top' });
    });
  }

  // ---------- chat da partida (provocação liberada, com moderação) ----------
  let lastChatAt = 0, bubbleTimers = [null, null];

  function showBubble(seat, text) {
    const el = $('#bubble' + seat);
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(bubbleTimers[seat]);
    bubbleTimers[seat] = setTimeout(() => el.classList.add('hidden'), 4500);
  }

  function sendChat(text) {
    text = String(text || '').trim().slice(0, 80);
    if (!text || !online.active) return;
    const now = Date.now();
    if (now - lastChatAt < 1500) { displayToast('Calma, uma mensagem por vez 😄'); return; }
    lastChatAt = now;
    NET.send({ t: 'chat', m: text });
    showBubble(online.seat, text);
    $('#overlay-chat').classList.add('hidden');
    $('#chat-text').value = '';
  }

  function bindChat() {
    $('#btn-chat').addEventListener('click', () => {
      if (online.active) $('#overlay-chat').classList.remove('hidden');
    });
    $('#chat-close').addEventListener('click', () => $('#overlay-chat').classList.add('hidden'));
    $('#chat-send').addEventListener('click', () => sendChat($('#chat-text').value));
    $('#chat-text').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat($('#chat-text').value); });
    document.querySelectorAll('#chat-presets button').forEach(b =>
      b.addEventListener('click', () => sendChat(b.textContent)));
    NET.on('chat', m => {
      showBubble(1 - online.seat, String(m.m || '').slice(0, 80));
      if (navigator.vibrate) navigator.vibrate(30);
    });
  }

  // ---------- reportar erro (chega na página do dono) ----------
  function bindReport() {
    $('#btn-report').addEventListener('click', () => {
      if (!NET.available()) { displayToast('O reporte vai pro servidor — abra o jogo pelo link.', 4500); return; }
      $('#overlay-report').classList.remove('hidden');
    });
    $('#report-close').addEventListener('click', () => $('#overlay-report').classList.add('hidden'));
    $('#report-send').addEventListener('click', () => {
      const texto = $('#report-text').value.trim();
      if (!texto) { displayToast('Escreve o que aconteceu primeiro 🙂'); return; }
      fetch('/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: myNick || 'anônimo', texto, aparelho: navigator.userAgent }),
      }).then(r => {
        if (!r.ok) throw new Error();
        $('#overlay-report').classList.add('hidden');
        $('#report-text').value = '';
        displayToast('🐞 Reporte enviado — valeu por ajudar a melhorar o jogo!', 4500);
      }).catch(() => displayToast('Não consegui enviar. Tenta de novo em instantes.', 4500));
    });
  }

  // ---------- anel do relógio de jogada (em volta do avatar) ----------
  function updateTimer(idx, frac) {
    for (let i = 0; i < 2; i++) {
      const el = $('#tring' + i);
      if (!el) continue;
      if (i !== idx || frac == null || frac <= 0) {
        el.style.background = 'transparent';
        continue;
      }
      const deg = Math.min(1, frac) * 360;
      const col = frac > 0.25 ? '#f0b429' : '#e04040';
      el.style.background = `conic-gradient(${col} ${deg}deg, rgba(255,255,255,0.10) ${deg}deg)`;
    }
  }

  // ---------- barra de força (controle próprio: funciona deitada ou em pé) ----------
  let powerVal = 55;
  function setPowerVal(v) {
    powerVal = Math.max(1, Math.min(100, Math.round(v)));
    Game.setPower(powerVal);
    const bar = $('#power-bar');
    const vert = bar.clientHeight > bar.clientWidth;
    const fill = $('#power-fill');
    fill.style.width = vert ? '100%' : powerVal + '%';
    fill.style.height = vert ? powerVal + '%' : '100%';
    // o degradê cobre a régua inteira; o preenchimento só revela até onde foi
    fill.style.background = vert
      ? 'linear-gradient(0deg, #2ec46e, #f0d429 60%, #e04040)'
      : 'linear-gradient(90deg, #2ec46e, #f0d429 60%, #e04040)';
    fill.style.backgroundSize = vert
      ? `100% ${10000 / powerVal}%`
      : `${10000 / powerVal}% 100%`;
    fill.style.backgroundPosition = 'left bottom';
  }
  function bindPower() {
    const bar = $('#power-bar');
    let drag = false;
    const fromEvent = e => {
      const r = bar.getBoundingClientRect();
      const vert = r.height > r.width;
      const v = vert
        ? (1 - (e.clientY - r.top) / r.height) * 100
        : ((e.clientX - r.left) / r.width) * 100;
      setPowerVal(v);
    };
    bar.addEventListener('pointerdown', e => {
      e.preventDefault();
      const hud = Game.getHud();
      if (hud && hud.humanCanAct && hud.state === 'aim') {
        drag = true;
        fromEvent(e);
      }
    });
    window.addEventListener('pointermove', e => { if (drag) fromEvent(e); });
    window.addEventListener('pointerup', () => { drag = false; });
    window.addEventListener('resize', () => setPowerVal(powerVal));
  }

  // segurar o botão de mira fina para girar continuamente
  function bindHold(el, fn) {
    let iv = 0;
    const stop = () => { clearInterval(iv); iv = 0; };
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      fn();
      iv = setInterval(fn, 50);
    });
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointerleave', stop);
  }

  // ---------- inicialização ----------
  document.addEventListener('DOMContentLoaded', () => {
    setCoins(coins);
    saveStats();
    PHYS.onImpact = (v, kind) => {
      Sfx.hit(v, kind);
      if (Game.impact) Game.impact(v, kind);
    };
    document.addEventListener('pointerdown', () => Sfx.ensure(), { once: true });

    // número de versão automático nas telas
    $('#app-ver').textContent = 'versão ' + APP_VER;
    $('#app-ver-auth').textContent = 'versão ' + APP_VER;

    // ---- cadastro / login ----
    setAuthMode('register');
    $('#auth-submit').addEventListener('click', submitAuth);
    $('#auth-pass').addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth(); });
    $('#auth-toggle').addEventListener('click', () => setAuthMode(authMode === 'register' ? 'login' : 'register'));
    $('#btn-logout').addEventListener('click', () => {
      if (confirm('Sair da sua conta neste aparelho?')) logout();
    });
    // link de afiliado escondido por ora (só volta quando tiver Pix/dinheiro real);
    // o back-end de indicação continua pronto pra ser religado.
    bootAuth();

    document.querySelectorAll('.menu-btn[data-setup]').forEach(b =>
      b.addEventListener('click', () => openSetup(b.dataset.setup)));

    document.querySelectorAll('#opt-mode .seg button').forEach(b =>
      b.addEventListener('click', () => refreshFormatLabels(b.dataset.v === 'tresbolas')));

    document.querySelectorAll('.seg').forEach(seg =>
      seg.addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (!btn) return;
        seg.querySelectorAll('button').forEach(x => x.classList.remove('sel'));
        btn.classList.add('sel');
      }));

    $('#btn-start').addEventListener('click', () => startMatch(buildCfg()));
    $('#btn-back').addEventListener('click', () => showScreen('screen-menu'));
    $('#btn-topup').addEventListener('click', () => setCoins(coins + 500));

    bindPower();
    setPowerVal(55);
    $('#btn-shoot').addEventListener('click', () => Game.humanShoot());
    bindHold($('#aim-left'), () => Game.nudgeAim(-1));
    bindHold($('#aim-right'), () => Game.nudgeAim(1));

    // efeito
    $('#btn-spin').addEventListener('click', openSpin);
    $('#spin-ball').addEventListener('pointerdown', e => { spinDrag = true; spinFromEvent(e); });
    window.addEventListener('pointermove', e => { if (spinDrag) spinFromEvent(e); });
    window.addEventListener('pointerup', () => { spinDrag = false; });
    $('#spin-reset').addEventListener('click', () => { spinSel = { x: 0, y: 0 }; placeSpinDot(); });
    $('#spin-ok').addEventListener('click', () => {
      Game.setSpin(spinSel.x, spinSel.y);
      $('#overlay-spin').classList.add('hidden');
      refreshControls();
    });

    $('#btn-exit').addEventListener('click', () => {
      const hud = Game.getHud();
      if (online.active) {
        const aviso = online.stake > 0 && !online.settled
          ? 'Sair agora PERDE a aposta (o adversário leva o pote). Sair mesmo assim?'
          : 'Sair da partida online?';
        if (hud && hud.state !== 'over' && !confirm(aviso)) return;
        onlineQuit();
        Game.stop();
        showScreen('screen-menu');
        return;
      }
      if (hud && hud.stake > 0 && hud.state !== 'over') {
        if (!confirm('Sair agora perde a aposta. Sair mesmo assim?')) return;
      }
      Game.stop();
      showScreen('screen-menu');
    });

    $('#btn-rematch').addEventListener('click', () => {
      if (online.active) {
        if (seriesPending) {
          // próximo jogo da mesma série (melhor de 3/5)
          if (online.seat === 0) hostNextGame();
          else if (!online.waiting) {
            online.waiting = true;
            NET.send({ t: 'nextreq' });
            $('#end-reason').textContent = 'Esperando o anfitrião começar o próximo jogo…';
          }
        } else if (!online.waiting) {
          // revanche agora é CONVITE: o outro precisa aceitar
          online.waiting = true;
          NET.send({ t: 'again' });
          $('#end-reason').textContent = 'Convite de revanche enviado — esperando o adversário…';
        }
        return;
      }
      if (seriesPending) {
        // continua a mesma série
        $('#overlay-end').classList.add('hidden');
        Game.nextGame();
        return;
      }
      if (!lastCfg) return;
      const cfg = { ...lastCfg, breaker: 1 - (lastCfg.breaker || 0) };
      startMatch(cfg);
    });
    $('#btn-menu').addEventListener('click', () => {
      if (online.active) {
        onlineQuit();
        Game.stop();
        $('#overlay-end').classList.add('hidden');
        showScreen('screen-menu');
        return;
      }
      const hud = Game.getHud();
      if (seriesPending && hud && hud.stake > 0) {
        if (!confirm('Abandonar a série perde a aposta. Sair mesmo assim?')) return;
      }
      seriesPending = false;
      $('#btn-rematch').textContent = 'REVANCHE'; $('#btn-rematch').classList.remove('hidden');
      $('#overlay-end').classList.add('hidden');
      Game.stop();
      showScreen('screen-menu');
    });

    bindOnline();
    bindChat();
    bindReport();

    // conecta em silêncio (letreiro de vitórias + checagem de versão) já no menu
    if (NET.available()) ensureHello(() => {});
  });

  return { toast, refreshHud, refreshControls, matchEnded, gameEnded, updateTimer };
})();
