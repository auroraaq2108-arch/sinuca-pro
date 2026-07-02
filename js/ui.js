// ui.js — telas, moedas de teste, sons, efeito e ligação com o jogo
const UI = (() => {
  const $ = s => document.querySelector(s);
  const RAKE = 0.10; // taxa da plataforma no desafio (10%)
  const BALL_HEX = { 1: '#f6c916', 2: '#2457d6', 3: '#e33131', 4: '#8b2fd6', 5: '#f07f1d', 6: '#1a9e57', 7: '#a12235', 8: '#181818' };

  let coins = parseInt(localStorage.getItem('sinuca_coins') || '500', 10);
  let stats = JSON.parse(localStorage.getItem('sinuca_stats') || '{"w":0,"l":0}');
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
    return { hit, ensure };
  })();

  // ---------- moedas / estatísticas ----------
  function setCoins(v) {
    coins = Math.max(0, Math.round(v));
    localStorage.setItem('sinuca_coins', String(coins));
    $('#coins').textContent = coins;
  }
  function saveStats() {
    localStorage.setItem('sinuca_stats', JSON.stringify(stats));
    $('#stats').textContent = `Vitórias: ${stats.w} · Derrotas: ${stats.l}`;
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
    showScreen('screen-setup');
  }

  function segValue(groupId) {
    const el = document.querySelector(`#${groupId} .seg .sel`);
    return el ? el.dataset.v : null;
  }

  function buildCfg() {
    const stake = setupKind === 'desafio' ? parseInt(segValue('opt-stake'), 10) : 0;
    return {
      mode: '8ball',
      p2: setupKind === '2p' ? 'human' : 'bot',
      level: segValue('opt-level') || 'medio',
      stake,
      // desafio = melhor de 3; aposta alta (1000+) = modo profissional, melhor de 5
      bestOf: setupKind === 'desafio' ? (stake >= 1000 ? 5 : 3) : 1,
      breaker: 0,
    };
  }

  function startMatch(cfg) {
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
      `<b>${match.players[0].name} ${match.wins[0]} × ${match.wins[1]} ${match.players[1].name}</b>`,
      `Melhor de ${match.bestOf} — primeiro a vencer ${target} jogos leva${match.stake > 0 ? ' o pote' : ''}.`,
    ];
    $('#end-lines').innerHTML = lines.map(l => `<div>${l}</div>`).join('');
    $('#btn-rematch').textContent = 'PRÓXIMO JOGO ▶';
    $('#overlay-end').classList.remove('hidden');
  }

  // ---------- fim de partida / série ----------
  function matchEnded(winner, reason, match) {
    seriesPending = false;
    $('#btn-rematch').textContent = 'REVANCHE';
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
      lines.push(`<b>Série: ${match.players[0].name} ${match.wins[0]} × ${match.wins[1]} ${match.players[1].name}</b>`);
    }
    if (match.stake > 0) {
      const pot = match.stake * 2;
      const fee = Math.round(pot * RAKE);
      const prize = pot - fee;
      lines.push(`Pote: 🪙 ${pot} (${match.stake} + ${match.stake})`);
      lines.push(`Taxa da plataforma (10%): −🪙 ${fee}`);
      if (youWon) {
        setCoins(coins + prize);
        lines.push(`<b>Você recebe: 🪙 ${prize}</b>`);
      } else {
        lines.push(`Prêmio do vencedor: 🪙 ${prize}`);
        lines.push(`<b>Você perdeu a aposta de 🪙 ${match.stake}</b>`);
      }
      lines.push(`Seu saldo: 🪙 ${coins}`);
    }
    $('#end-lines').innerHTML = lines.map(l => `<div>${l}</div>`).join('');

    if (p2bot || vsRemote) {
      if (youWon) stats.w++; else stats.l++;
      saveStats();
    }
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

  function refreshHud() {
    const hud = Game.getHud();
    if (!hud) return;
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
    let mid = hud.mode === '8ball' ? '8 BALL' : hud.mode === '9ball' ? '9 BALL' : 'LISAS × LISTRADAS';
    if (hud.stake > 0) mid += ` · 🪙 ${hud.stake}`;
    $('#mode-badge').textContent = mid;
    const sb = $('#series-badge');
    if (hud.bestOf > 1) {
      sb.textContent = `${hud.stake >= 1000 ? '⭐ PRO · ' : ''}Melhor de ${hud.bestOf} · ${hud.wins[0]} × ${hud.wins[1]}`;
      sb.classList.remove('hidden');
    } else {
      sb.classList.add('hidden');
    }
    const midTray = $('#mid-tray');
    if (hud.nine) {
      midTray.innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9]
        .map(n => miniBall(n, !hud.nine.includes(n))).join('');
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
    $('#power').disabled = !can;
    $('#btn-spin').disabled = !can;
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

  // ---------- jogar online (sala com código) ----------
  const online = { active: false, seat: 0, lastBreaker: 0, waiting: false };

  function onlineStatus(msg, big) {
    const el = $('#online-status');
    el.innerHTML = big
      ? `Passe este código pro seu amigo:<div class="room-code-big">${big}</div>Esperando ele entrar…`
      : msg;
  }

  function openOnline() {
    if (!NET.available()) {
      displayToast('Pra jogar online, abra o jogo pelo INICIAR-SERVIDOR.bat (veja o LEIA-ME)', 5000);
      return;
    }
    onlineStatus('');
    $('#room-code').value = '';
    showScreen('screen-online');
  }

  function onlineBegin(seat, ballsArr, breaker) {
    online.active = true;
    online.seat = seat;
    online.lastBreaker = breaker;
    online.waiting = false;
    $(`#pbox${seat} .avatar`).textContent = '😎';
    $(`#pbox${1 - seat} .avatar`).textContent = '🧑';
    $('#overlay-end').classList.add('hidden');
    showScreen('screen-game');
    Game.start({
      mode: '8ball',
      p2: 'online',
      online: { seat },
      balls: ballsArr,
      breaker,
      stake: 0,
      bestOf: 1,
    });
    refreshHud();
  }

  // anfitrião (assento 0) monta a mesa e manda pro convidado
  function hostStart(breaker) {
    const rackBalls = Game.makeRack();
    NET.send({ t: 'start', balls: rackBalls, breaker });
    onlineBegin(0, rackBalls, breaker);
  }

  function onlineQuit(msg) {
    const inGame = online.active;
    online.active = false;
    online.waiting = false;
    NET.disconnect();
    if (inGame) {
      Game.stop();
      $('#overlay-end').classList.add('hidden');
      showScreen('screen-menu');
      if (msg) displayToast(msg, 4500);
    } else if (msg) {
      onlineStatus(msg);
    }
  }

  function bindOnline() {
    $('#btn-online').addEventListener('click', openOnline);
    $('#btn-online-back').addEventListener('click', () => { onlineQuit(); showScreen('screen-menu'); });

    $('#btn-create-room').addEventListener('click', () => {
      onlineStatus('Conectando…');
      NET.connect(ok => {
        if (!ok) { onlineStatus('Servidor não encontrado. Abra o jogo pelo INICIAR-SERVIDOR.bat.'); return; }
        NET.send({ t: 'create' });
      });
    });

    $('#btn-join-room').addEventListener('click', () => {
      const code = $('#room-code').value.trim().toUpperCase();
      if (code.length !== 4) { onlineStatus('Digite o código de 4 letras da sala.'); return; }
      onlineStatus('Conectando…');
      NET.connect(ok => {
        if (!ok) { onlineStatus('Servidor não encontrado. Abra o jogo pelo INICIAR-SERVIDOR.bat.'); return; }
        NET.send({ t: 'join', code });
      });
    });

    // mensagens do servidor
    NET.on('created', m => onlineStatus('', m.code));
    NET.on('err', m => onlineStatus('⚠ ' + m.m));
    NET.on('joined', () => onlineStatus('Conectado! Esperando o anfitrião começar…'));
    NET.on('peer', () => hostStart(0));                 // amigo entrou: anfitrião inicia
    NET.on('start', m => onlineBegin(1, m.balls, m.breaker));
    NET.on('left', () => onlineQuit('O adversário saiu da partida.'));
    NET.on('drop', () => onlineQuit('Conexão perdida. Verifique o Wi-Fi e crie uma nova sala.'));

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

    document.querySelectorAll('.menu-btn').forEach(b =>
      b.addEventListener('click', () => openSetup(b.dataset.setup)));

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

    $('#power').addEventListener('input', e => Game.setPower(parseInt(e.target.value, 10)));
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
        if (hud && hud.state !== 'over' && !confirm('Sair da partida online?')) return;
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
        if (online.seat === 0) {
          hostStart(1 - online.lastBreaker); // anfitrião monta a mesa nova
        } else if (!online.waiting) {
          online.waiting = true;
          NET.send({ t: 'again' });
          $('#end-reason').textContent = 'Esperando o anfitrião aceitar a revanche…';
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
      $('#btn-rematch').textContent = 'REVANCHE';
      $('#overlay-end').classList.add('hidden');
      Game.stop();
      showScreen('screen-menu');
    });

    bindOnline();
  });

  return { toast, refreshHud, refreshControls, matchEnded, gameEnded, updateTimer };
})();
