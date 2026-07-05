// game.js — partida: regras (8/9 ball), turnos, bots, efeito e desenho da mesa
const Game = (() => {
  const { W, H, R, POCKETS } = PHYS;
  const M = 50; // margem da madeira no canvas (canvas lógico = 900x500)
  const HEAD_X = 200; // linha de saída: bola na mão só atrás dela (regra de bar)

  const COLORS = { 1: '#f6c916', 2: '#2457d6', 3: '#e33131', 4: '#8b2fd6', 5: '#f07f1d', 6: '#1a9e57', 7: '#a12235', 8: '#181818' };
  const LEVEL_NAMES = { iniciante: 'Iniciante', medio: 'Médio', pro: 'Profissional' };
  const colorOf = n => COLORS[n > 8 ? n - 8 : n];
  const moneyBall = () => 8;
  const groupOf = n => n === 8 ? 'eight' : n < 8 ? 'solid' : 'stripe';
  const groupLabel = g => g === 'solid' ? 'Lisas' : g === 'stripe' ? 'Listradas' : '—';

  let canvas = null, ctx = null;
  let cache = {}; // gradientes estáticos
  let match = null;
  let balls = [];
  let state = 'idle'; // aim | shooting | ballInHand | over
  let current = 0;
  let openTable = true, breakShot = true;
  let aimAngle = 0, power = 55;
  let spin = { x: 0, y: 0 };
  let shotEv = null, shotCtx = null, shotClock = 0;
  const TURN_TIME = 60; // 1 minuto por jogada
  let shotTimer = TURN_TIME, timerAcc = 0;
  let botAnim = null, token = 0;
  let ghost = null;
  let sinkAnims = [];
  let shake = 0, trail = [], parts = [], strike = null;
  // online: este aparelho é a "autoridade" da tacada atual (simula a física e transmite)
  let netAuth = false, snapAcc = 0, aimAcc = 0;
  const TILT_A = 9 * Math.PI / 180, TILT_D = 1100; // perspectiva 2.5D (CSS)
  let raf = 0, lastT = 0;
  let aiming = false;

  // ---------- utilidades ----------
  const cue = () => balls[0];
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const mkBall = (n, x, y) => ({ n, x, y, vx: 0, vy: 0, active: true, spinX: 0, spinY: 0 });
  const lowest = () => { let m = null; for (const b of balls) if (b.active && b.n > 0 && (m === null || b.n < m)) m = b.n; return m; };
  const remaining = g => balls.filter(b => b.active && b.n > 0 && groupOf(b.n) === g).length;
  const humanTurn = () => !!match && match.players[current].type === 'human';

  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const t = f < 0 ? 0 : 255, p = Math.abs(f);
    r = Math.round((t - r) * p + r);
    g = Math.round((t - g) * p + g);
    b = Math.round((t - b) * p + b);
    return `rgb(${r},${g},${b})`;
  }

  function legalTargets() {
    const p = match.players[current];
    if (match.mode === '9ball') { const l = lowest(); return l ? [l] : []; }
    if (match.mode === 'tresbolas') return balls.filter(b => b.active && b.n > 0).map(b => b.n);
    const mb = moneyBall();
    if (openTable) return balls.filter(b => b.active && b.n > 0 && b.n !== mb).map(b => b.n);
    if (remaining(p.group) === 0) return [mb];
    return balls.filter(b => b.active && b.n > 0 && groupOf(b.n) === p.group).map(b => b.n);
  }

  // ---------- montagem das bolas ----------
  // variação aleatória: cada break fica único (mesa real nunca é perfeita).
  // No break a física é caótica — deslocamentos pequenos mudam todo o resultado,
  // então nenhuma tacada "decorada" encaçapa sempre a mesma bola.
  function jitter(bs) {
    for (let i = 1; i < bs.length; i++) {          // 0 = bola branca, não mexe
      bs[i].x += (Math.random() - 0.5) * 1.0;
      bs[i].y += (Math.random() - 0.5) * 1.0;
    }
    bs[0].x += (Math.random() - 0.5) * 14;         // branca sai de um ponto diferente
    bs[0].y += (Math.random() - 0.5) * 14;
    return bs;
  }

  function rack(mode) {
    const bs = [mkBall(0, 200, H / 2)];
    // folga maior entre as bolas: o triângulo espalha diferente a cada saída
    const fx = 600, dx = Math.sqrt(3) * R + 1.4, dy = 2 * R + 1.4;
    if (mode === 'tresbolas') {
      // jogo raiz de bar: 3 bolas, quem matar 2 primeiro vence
      const ns = shuffle([1, 2, 3]);
      bs.push(mkBall(ns[0], fx, H / 2));
      bs.push(mkBall(ns[1], fx + dx, H / 2 - (R + 0.9)));
      bs.push(mkBall(ns[2], fx + dx, H / 2 + (R + 0.9)));
      return jitter(bs);
    }
    if (mode === '8ball') {
      const g1 = shuffle([1, 2, 3, 4, 5, 6, 7]);
      const g2 = shuffle([9, 10, 11, 12, 13, 14, 15]);
      const nums = new Array(15).fill(0);
      nums[4] = 8;                // a 8 no centro
      nums[10] = g1.pop();        // cantos traseiros: um de cada grupo
      nums[14] = g2.pop();
      const rest = shuffle(g1.concat(g2));
      for (let k = 0; k < 15; k++) if (!nums[k]) nums[k] = rest.pop();
      let k = 0;
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j <= i; j++) {
          bs.push(mkBall(nums[k++], fx + i * dx, H / 2 + (j - i / 2) * dy));
        }
      }
    } else {
      const rows = [1, 2, 3, 2, 1];
      const rest = shuffle([2, 3, 4, 5, 6, 7, 8]);
      for (let i = 0; i < rows.length; i++) {
        const s = rows[i];
        for (let j = 0; j < s; j++) {
          let n;
          if (i === 0) n = 1;
          else if (i === 2 && j === 1) n = 9;
          else n = rest.pop();
          bs.push(mkBall(n, fx + i * dx, H / 2 + (j - (s - 1) / 2) * dy));
        }
      }
    }
    return jitter(bs);
  }

  // ---------- fluxo da partida ----------
  function start(cfg) {
    token++;
    ensureCanvas();
    let players;
    if (cfg.online) {
      // online: mesmos nomes (apelidos) nos dois aparelhos, por assento
      players = [0, 1].map(i => ({
        name: (cfg.names && cfg.names[i]) || `Jogador ${i + 1}`,
        type: i === cfg.online.seat ? 'human' : 'remote',
        level: null,
        group: null,
      }));
    } else {
      players = [
        { name: cfg.p2 === 'human' ? 'Jogador 1' : 'Você', type: 'human', level: null, group: null },
        cfg.p2 === 'human'
          ? { name: 'Jogador 2', type: 'human', level: null, group: null }
          : { name: 'Bot ' + LEVEL_NAMES[cfg.level], type: 'bot', level: cfg.level, group: null },
      ];
    }
    match = {
      mode: cfg.mode,
      stake: cfg.stake || 0,
      bestOf: cfg.bestOf || 1,
      wins: [0, 0],
      gameNum: 1,
      breaker: cfg.breaker || 0,
      online: !!cfg.online,
      localSeat: cfg.online ? cfg.online.seat : 0,
      potCount: [0, 0],
      players,
    };
    balls = cfg.balls ? cfg.balls.map(b => mkBall(b.n, b.x, b.y)) : rack(cfg.mode);
    state = 'aim';
    current = match.breaker;
    openTable = true; breakShot = true;
    ghost = null; botAnim = null; aiming = false;
    sinkAnims = []; trail = []; parts = []; strike = null;
    netAuth = false; snapAcc = 0; aimAcc = 0;
    spin = { x: 0, y: 0 };
    // força NÃO reseta: fica onde o jogador deixou na barra (evita dessincronia)
    shotTimer = TURN_TIME;
    autoAim();
    if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(loop); }
    UI.refreshHud(); UI.refreshControls();
    UI.toast(current === 0 ? `${match.players[0].name} começa — boa sorte!` : `${match.players[1].name} começa`);
    maybeBot();
  }

  function stop() {
    token++;
    state = 'idle';
    match = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.033, (t - lastT) / 1000 || 0.016);
    lastT = t;
    if (state === 'shooting') {
      PHYS.step(balls, dt, shotEv);
      shotClock += dt;
      if (shotClock > 14) for (const b of balls) { b.vx = 0; b.vy = 0; }
      // rotação visual das bolas + rastro da branca
      for (const b of balls) {
        if (!b.active) continue;
        const v = Math.hypot(b.vx, b.vy);
        if (v > 5) {
          b.roll = (b.roll || 0) + v * dt / R;
          b.rollA = Math.atan2(b.vy, b.vx);
        }
      }
      const c0 = cue();
      if (c0.active) {
        const cv = Math.hypot(c0.vx, c0.vy);
        if (cv > 260) {
          trail.push({ x: c0.x, y: c0.y, life: 0.3 });
          if (trail.length > 24) trail.shift();
        }
      }
      // online: a autoridade transmite as posições enquanto as bolas rolam
      if (match.online && netAuth) {
        snapAcc += dt;
        if (snapAcc >= 0.04) {
          snapAcc = 0;
          NET.send({
            t: 'snap',
            b: balls.map(b => [b.n, Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10, b.active ? 1 : 0]),
          });
        }
      }
      if (!PHYS.anyMoving(balls)) {
        if (match.mode === '9ball') resolve9();
        else if (match.mode === 'tresbolas') resolve3();
        else resolve8();
      }
    } else if (state === 'watch') {
      // este aparelho está assistindo a tacada do adversário: suaviza os snapshots
      for (const b of balls) {
        if (!b.active || b.tx == null) continue;
        const dx = (b.tx - b.x) * Math.min(1, dt * 18);
        const dy = (b.ty - b.y) * Math.min(1, dt * 18);
        b.x += dx; b.y += dy;
        const d = Math.hypot(dx, dy);
        b.lerpMoving = d > 0.15;
        if (b.lerpMoving) {
          b.roll = (b.roll || 0) + d / R;
          b.rollA = Math.atan2(dy, dx);
        }
      }
    }
    // (a mira do adversário NÃO é transmitida: cada um mira em segredo)
    if (botAnim) {
      botAnim.t += dt;
      const k = Math.min(1, botAnim.t / botAnim.dur);
      const e = k * k * (3 - 2 * k);
      let d = botAnim.to - botAnim.from;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      aimAngle = botAnim.from + d * e;
      if (botAnim.t >= botAnim.dur + 0.35) {
        const p = botAnim.power;
        botAnim = null;
        doShoot(p);
      }
    }
    // relógio de 1 minuto por jogada (online: só o aparelho da vez aplica a falta)
    if (match && (state === 'aim' || state === 'ballInHand')) {
      shotTimer -= dt;
      if (shotTimer <= 0) {
        if (!match.online || humanTurn()) timeoutFoul();
        else shotTimer = 0;
      }
    }
    timerAcc += dt;
    if (timerAcc > 0.15) {
      timerAcc = 0;
      if (state === 'aim' || state === 'ballInHand') UI.updateTimer(current, shotTimer / TURN_TIME);
      else UI.updateTimer(-1);
    }
    for (const s of sinkAnims) s.t += dt;
    sinkAnims = sinkAnims.filter(s => s.t < 0.3);
    // efeitos: tremida, rastro, partículas, taco disparando
    shake = Math.max(0, shake - dt * 26);
    for (const p of trail) p.life -= dt;
    trail = trail.filter(p => p.life > 0);
    for (const p of parts) {
      p.life -= dt;
      p.x += (p.vx || 0) * dt;
      p.y += (p.vy || 0) * dt;
    }
    parts = parts.filter(p => p.life > 0);
    if (strike) {
      strike.t += dt;
      if (strike.t > 0.3) strike = null;
    }
    render();
  }

  function timeoutFoul() {
    shotTimer = TURN_TIME;
    aiming = false;
    botAnim = null;
    if (match.online) netAuth = true; // este aparelho resolve e transmite a falta
    let castigo = null;
    if (match.mode !== '9ball') castigo = applyCastigo();
    if (castigo && castigo.win) {
      const o = match.players[1 - current];
      return endMatch(1 - current, `Tempo esgotado com ${o.name} na bola 8 — o castigo tirou a 8!`);
    }
    finishTurn('tempo esgotado', false, match.mode === '9ball', castigo ? castigo.n : null);
  }

  function autoAim() {
    if (!match || !cue().active) return;
    const ts = legalTargets();
    let best = null, bd = Infinity;
    for (const b of balls) {
      if (!b.active || !ts.includes(b.n)) continue;
      const d = Math.hypot(b.x - cue().x, b.y - cue().y);
      if (d < bd) { bd = d; best = b; }
    }
    if (best) aimAngle = Math.atan2(best.y - cue().y, best.x - cue().x);
  }

  function doShoot(speed) {
    if (state !== 'aim' || !cue().active) return;
    const c = cue();
    const v = Math.max(60, Math.min(PHYS.MAX_V, speed));
    // no break, um tiquinho de aleatoriedade na direção (imperceptível, ~0.4°):
    // a mesma tacada de saída nunca cai a mesma bola — mata o "decoreba"
    const ang = breakShot ? aimAngle + (Math.random() - 0.5) * 0.014 : aimAngle;
    c.vx = Math.cos(ang) * v;
    c.vy = Math.sin(ang) * v;
    c.spinX = spin.x;
    c.spinY = spin.y;
    strike = { t: 0, x: c.x, y: c.y, angle: aimAngle, pull0: 16 + Math.max(0, (v - 80) / (PHYS.MAX_V - 80)) * 30 };
    trail = [];
    if (match.online && match.players[current].type === 'human') {
      netAuth = true;
      snapAcc = 0;
      NET.send({ t: 'shot', a: aimAngle, p: v, cx: c.x, cy: c.y });
    }
    spin = { x: 0, y: 0 };
    shotEv = { firstHit: null, potted: [], cuePotted: false };
    const p = match.players[current];
    shotCtx = { breakShot, lowestBefore: lowest(), remainBefore: p.group ? remaining(p.group) : null };
    shotClock = 0;
    state = 'shooting';
    botAnim = null;
    UI.refreshControls();
  }

  function humanShoot() {
    if (!humanTurn() || state !== 'aim' || botAnim) return;
    // curva progressiva: metade de baixo da barra = tacadas suaves de precisão
    const k = Math.pow(power / 100, 1.6);
    doShoot(80 + k * (PHYS.MAX_V - 80));
  }

  // ---------- regras: 8 ball ----------
  function resolve8() {
    const p = match.players[current], o = match.players[1 - current];
    const mb = moneyBall();
    let foul = null;
    if (shotEv.cuePotted) foul = 'bola branca caiu';
    else if (shotEv.firstHit == null) foul = 'não tocou em nenhuma bola';
    else if (!shotCtx.breakShot) {
      if (!openTable) {
        const need = shotCtx.remainBefore === 0 ? 'eight' : p.group;
        if (groupOf(shotEv.firstHit) !== need) foul = 'tocou primeiro na bola errada';
      } else if (shotEv.firstHit === mb) foul = `não pode tocar a ${mb} primeiro`;
    }
    // derrubar bola do adversário é falta (regra de bar), mesmo matando a sua junto
    if (!foul && !openTable && p.group) {
      const enemy = shotEv.potted.find(n => n !== mb && groupOf(n) === o.group);
      if (enemy != null) foul = `derrubou a bola ${enemy} do adversário`;
    }
    const pots = shotEv.potted.filter(n => n !== mb);
    if (shotEv.potted.includes(mb)) {
      if (shotCtx.breakShot) {
        respot(mb);
        UI.toast(`Bola ${mb} caiu no break — devolvida à mesa`);
      } else if (foul || shotCtx.remainBefore !== 0) {
        return endMatch(1 - current, `${p.name} encaçapou a ${mb} na hora errada`);
      } else {
        return endMatch(current, `Bola ${mb} encaçapada!`);
      }
    }
    let assigned = null;
    if (openTable && !foul && pots.length) {
      p.group = groupOf(pots[0]);
      o.group = p.group === 'solid' ? 'stripe' : 'solid';
      openTable = false;
      assigned = pots[0];
    }
    // castigo (regra brasileira): falta faz sair a menor bola do adversário
    const castigo = foul ? applyCastigo() : null;
    if (castigo && castigo.win) {
      // adversário estava na 8: o castigo tirou a própria 8 — vitória dele
      return endMatch(1 - current, `Falta de ${p.name} com ${o.name} na bola 8 — o castigo tirou a 8!`);
    }
    let again = false;
    if (!foul && pots.length) again = openTable || pots.some(n => groupOf(n) === p.group);
    breakShot = false;
    finishTurn(foul, again, false, castigo ? castigo.n : null);
    if (assigned) {
      UI.toast(`${p.name} ficou com as ${groupLabel(p.group).toLowerCase()} · joga de novo! `, 4000, assigned);
    }
  }

  // ---------- regras: 3 bolas (bar raiz) ----------
  function resolve3() {
    const p = match.players[current];
    let foul = null;
    if (shotEv.cuePotted) foul = 'bola branca caiu';
    else if (shotEv.firstHit == null) foul = 'não tocou em nenhuma bola';
    breakShot = false;
    if (foul) {
      // bola matada com falta não vale: volta pra mesa
      for (const n of shotEv.potted) respot(n);
      if (shotEv.potted.length) foul += ' · bola devolvida';
      finishTurn(foul, false, false, null);
      return;
    }
    if (shotEv.potted.length) {
      match.potCount[current] += shotEv.potted.length;
      UI.refreshHud();
      if (match.potCount[current] >= 2) {
        return endMatch(current, `${p.name} matou 2 bolas!`);
      }
    }
    finishTurn(null, shotEv.potted.length > 0, false, null);
  }

  // ---------- regras: 9 ball ----------
  function resolve9() {
    let foul = null;
    if (shotEv.cuePotted) foul = 'bola branca caiu';
    else if (shotEv.firstHit == null) foul = 'não tocou em nenhuma bola';
    else if (shotEv.firstHit !== shotCtx.lowestBefore) foul = `tinha que tocar primeiro na bola ${shotCtx.lowestBefore}`;
    if (shotEv.potted.includes(9)) {
      if (!foul) return endMatch(current, 'Bola 9 encaçapada!');
      respot(9);
      UI.toast('Bola 9 devolvida à mesa (falta)');
    }
    breakShot = false;
    finishTurn(foul, !foul && shotEv.potted.length > 0, true, null);
  }

  function finishTurn(foul, again, takeCue, castigo) {
    if (foul) {
      current = 1 - current;
      const c = cue();
      if (takeCue) { c.active = false; c.vx = 0; c.vy = 0; }
      const nextState = !c.active ? 'ballInHand' : 'aim';
      let msg = `Falta (${foul}) · `;
      msg += nextState === 'ballInHand'
        ? `${match.players[current].name} joga da saída (atrás da linha)`
        : `vez de ${match.players[current].name}`;
      if (castigo) msg += ` · Penalidade: sai a bola `;
      UI.toast(msg, castigo ? 4200 : 4000, castigo);
      // pausa para todo mundo ver a penalidade antes do próximo jogar
      state = 'pause';
      ghost = null;
      UI.refreshHud(); UI.refreshControls();
      netSyncSend();
      const tk = token;
      setTimeout(() => {
        if (tk !== token || !match || state !== 'pause') return;
        state = nextState;
        shotTimer = TURN_TIME;
        autoAim();
        UI.refreshHud(); UI.refreshControls();
        netSyncSend();
        maybeBot();
      }, castigo ? 3000 : 1200);
      return;
    }
    if (again) {
      state = 'aim';
      UI.toast(`${match.players[current].name} joga de novo!`);
    } else {
      current = 1 - current;
      state = 'aim';
      UI.toast(`Vez de ${match.players[current].name}`);
    }
    shotTimer = TURN_TIME;
    autoAim();
    UI.refreshHud(); UI.refreshControls();
    netSyncSend();
    maybeBot();
  }

  // próximo jogo da série online: os dois aparelhos aplicam a mesma mesa
  function nextGameOnline(ballsArr) {
    token++;
    match.gameNum++;
    match.breaker = 1 - match.breaker;
    match.potCount = [0, 0];
    for (const p of match.players) p.group = null;
    balls = ballsArr.map(b => mkBall(b.n, b.x, b.y));
    state = 'aim';
    current = match.breaker;
    openTable = true; breakShot = true;
    ghost = null; botAnim = null; aiming = false;
    sinkAnims = []; trail = []; parts = []; strike = null;
    netAuth = false; snapAcc = 0;
    spin = { x: 0, y: 0 };
    // força mantida entre jogos
    shotTimer = TURN_TIME;
    autoAim();
    UI.refreshHud(); UI.refreshControls();
    UI.toast(`Jogo ${match.gameNum} — ${match.players[current].name} começa`);
  }

  // ---------- online: sincronização entre os dois aparelhos ----------
  function packState() {
    return {
      balls: balls.map(b => [b.n, Math.round(b.x * 100) / 100, Math.round(b.y * 100) / 100, b.active ? 1 : 0]),
      current,
      state,
      openTable,
      breakShot,
      groups: [match.players[0].group, match.players[1].group],
      wins: match.wins.slice(),
      pots: match.potCount.slice(),
      gameNum: match.gameNum,
      breaker: match.breaker,
    };
  }

  function netSyncSend() {
    if (match && match.online && netAuth) NET.send({ t: 'sync', s: packState() });
  }

  // o adversário tacou: vira espectador da jogada dele
  function netShot(m) {
    if (!match) return;
    const c = cue();
    c.active = true;
    c.x = m.cx; c.y = m.cy; c.vx = 0; c.vy = 0;
    aimAngle = m.a;
    strike = { t: 0, x: m.cx, y: m.cy, angle: m.a, pull0: 16 + Math.max(0, (m.p - 80) / (PHYS.MAX_V - 80)) * 30 };
    trail = [];
    netAuth = false;
    state = 'watch';
    for (const b of balls) { b.tx = b.x; b.ty = b.y; }
    UI.refreshControls();
  }

  function netSnap(m) {
    if (!match) return;
    for (const [n, x, y, act] of m.b) {
      const b = balls.find(bb => bb.n === n);
      if (!b) continue;
      if (b.active && !act) {
        b.active = false;
        spawnPotFx(b.n, x, y); // caiu na mesa do adversário: efeito local
      }
      b.tx = x; b.ty = y;
      if (!b.active) { b.x = x; b.y = y; }
    }
  }

  function netSync(m) {
    if (!match) return;
    const s = m.s;
    for (const [n, x, y, act] of s.balls) {
      const b = balls.find(bb => bb.n === n);
      if (!b) continue;
      b.x = x; b.y = y; b.vx = 0; b.vy = 0;
      b.active = !!act;
      b.tx = null; b.ty = null; b.lerpMoving = false;
    }
    current = s.current;
    state = s.state;
    openTable = s.openTable;
    breakShot = s.breakShot;
    match.players[0].group = s.groups[0];
    match.players[1].group = s.groups[1];
    match.wins = s.wins.slice();
    if (s.pots) match.potCount = s.pots.slice();
    match.gameNum = s.gameNum;
    match.breaker = s.breaker;
    ghost = null;
    shotTimer = TURN_TIME;
    trail = [];
    if (state === 'aim') autoAim();
    UI.refreshHud(); UI.refreshControls();
  }

  function netPlace(m) {
    if (!match) return;
    const c = cue();
    c.active = true;
    c.x = m.x; c.y = m.y; c.vx = 0; c.vy = 0;
    if (state === 'ballInHand') state = 'aim';
    UI.refreshHud(); UI.refreshControls();
  }

  function netAim(m) {
    if (match && state === 'aim' && !humanTurn()) aimAngle = m.a;
  }

  function netEnd(m) {
    if (!match) return;
    netAuth = false;
    if (m.s) netSync({ s: m.s });
    endMatch(m.w, m.r);
  }

  // alguém reconectou: quem ficou normaliza a mesa e manda o estado completo
  function resumeShare() {
    if (!match || !match.online) return;
    if (state === 'watch' || state === 'shooting') {
      // tacada interrompida pela queda: congela as bolas onde estão
      for (const b of balls) {
        b.vx = 0; b.vy = 0;
        b.tx = null; b.ty = null; b.lerpMoving = false;
      }
      state = 'aim';
      netAuth = false;
      shotTimer = TURN_TIME;
      autoAim();
      UI.refreshHud(); UI.refreshControls();
    }
    NET.send({ t: 'sync', s: packState() });
  }

  // animação + faíscas + som de bola encaçapada
  function spawnPotFx(n, x, y, pocket) {
    let p = pocket;
    if (!p) {
      let bd = Infinity;
      for (const pk of POCKETS) {
        const d = Math.hypot(x - pk.x, y - pk.y);
        if (d < bd) { bd = d; p = pk; }
      }
    }
    sinkAnims.push({ n, x, y, px: p.x, py: p.y, t: 0 });
    parts.push({ x: p.x, y: p.y, life: 0.3, flash: true });
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 50 + Math.random() * 110;
      parts.push({
        x: p.x, y: p.y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.35 + Math.random() * 0.2,
        big: Math.random() < 0.3,
        col: Math.random() < 0.5 ? '#ffe9a3' : '#ffffff',
      });
    }
    if (!pocket && PHYS.onImpact) PHYS.onImpact(1, 'pot'); // som (a física já toca quando é local)
  }

  // castigo: sai a menor bola do adversário do jogador da vez.
  // Se ele já está na 8 (grupo limpo), o castigo tira a PRÓPRIA 8 = vitória dele.
  function applyCastigo() {
    const victim = match.players[1 - current];
    if (!victim.group) return null;
    if (remaining(victim.group) === 0) {
      const b8 = balls.find(b => b.n === moneyBall() && b.active);
      if (b8) {
        b8.active = false;
        spawnPotFx(b8.n, b8.x, b8.y);
      }
      return { win: true, n: moneyBall() };
    }
    let low = null;
    for (const b of balls) {
      if (b.active && b.n > 0 && groupOf(b.n) === victim.group && (!low || b.n < low.n)) low = b;
    }
    if (!low) return null;
    let bp = POCKETS[0], bd = Infinity;
    for (const pk of POCKETS) {
      const d = Math.hypot(low.x - pk.x, low.y - pk.y);
      if (d < bd) { bd = d; bp = pk; }
    }
    low.active = false;
    sinkAnims.push({ n: low.n, x: low.x, y: low.y, px: bp.x, py: bp.y, t: 0 });
    if (PHYS.onImpact) PHYS.onImpact(1, 'pot');
    return { n: low.n };
  }

  function respot(n) {
    const b = balls.find(b => b.n === n);
    let x = 600;
    while (!PHYS.validSpot(balls, x, H / 2) && x < W - R - 2) x += 6;
    b.x = x; b.y = H / 2; b.vx = 0; b.vy = 0; b.active = true;
  }

  function placeCue(x, y) {
    const c = cue();
    c.x = x; c.y = y; c.vx = 0; c.vy = 0; c.active = true;
    ghost = null;
    state = 'aim';
    shotTimer = TURN_TIME;
    if (match.online && humanTurn()) NET.send({ t: 'place', x, y });
    autoAim();
    UI.refreshHud(); UI.refreshControls();
  }

  function endMatch(w, reason) {
    if (match.online && netAuth) {
      NET.send({ t: 'end', w, r: reason, s: packState() }); // antes do wins++: o outro lado incrementa o dele
      netAuth = false;
    }
    state = 'over';
    token++;
    botAnim = null;
    match.wins[w]++;
    UI.refreshHud(); UI.refreshControls();
    UI.updateTimer(-1);
    const target = Math.ceil(match.bestOf / 2);
    if (match.bestOf > 1 && match.wins[w] < target) {
      UI.gameEnded(w, reason, match);   // jogo da série acabou, série continua
    } else {
      UI.matchEnded(w, reason, match);  // série (ou jogo único) decidida
    }
  }

  // próximo jogo da série: re-arma a mesa, alterna quem sai
  function nextGame() {
    token++;
    match.gameNum++;
    match.breaker = 1 - match.breaker;
    match.potCount = [0, 0];
    for (const p of match.players) p.group = null;
    balls = rack(match.mode);
    state = 'aim';
    current = match.breaker;
    openTable = true; breakShot = true;
    ghost = null; botAnim = null; aiming = false;
    sinkAnims = [];
    spin = { x: 0, y: 0 };
    // força mantida entre jogos
    shotTimer = TURN_TIME;
    autoAim();
    UI.refreshHud(); UI.refreshControls();
    UI.toast(`Jogo ${match.gameNum} — ${match.players[current].name} começa`);
    maybeBot();
  }

  // ---------- bot ----------
  function maybeBot() {
    if (!match) return;
    const p = match.players[current];
    if (state === 'over' || p.type !== 'bot') return;
    const tk = token;
    setTimeout(() => {
      if (tk !== token || !match || state === 'over') return;
      if (state === 'ballInHand') {
        const spot = AI.placeCueBall(balls, legalTargets(), p.level);
        placeCue(spot.x, spot.y);
        setTimeout(() => { if (tk === token && state === 'aim') botAim(); }, 500);
      } else if (state === 'aim') {
        botAim();
      }
    }, 900);
  }

  function botAim() {
    const p = match.players[current];
    const shot = AI.chooseShot(cue(), balls, legalTargets(), p.level);
    botAnim = { from: aimAngle, to: shot.angle, t: 0, dur: 0.7, power: shot.power };
  }

  // ---------- entrada (mouse/toque) ----------
  // converte o toque na tela para a mesa, desfazendo a inclinação 2.5D
  function pointerPos(e) {
    const r = canvas.parentElement.getBoundingClientRect();
    const X = e.clientX - (r.left + r.width / 2);
    const Y = e.clientY - (r.top + r.height / 2);
    const cos = Math.cos(TILT_A), sin = Math.sin(TILT_A);
    const y = Y * TILT_D / (TILT_D * cos + Y * sin);
    const x = X * (TILT_D - y * sin) / TILT_D;
    return {
      x: (x + r.width / 2) / r.width * 900 - M,
      y: (y + r.height / 2) / r.height * 500 - M,
    };
  }

  let aimMode = 'ball';
  const angDiff = (a, b) => {
    let d = a - b;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  };

  function onDown(e) {
    e.preventDefault();
    if (!match) return;
    const p = pointerPos(e);
    if (humanTurn() && state === 'aim' && !botAnim) {
      // pegou no taco (atrás da branca)? então mira arrastando o taco
      const c = cue();
      const dx = p.x - c.x, dy = p.y - c.y;
      const d = Math.hypot(dx, dy);
      const diff = angDiff(Math.atan2(dy, dx), aimAngle + Math.PI);
      aimMode = (d > R + 4 && d < 280 && Math.abs(diff) < 0.6) ? 'stick' : 'ball';
      aiming = true;
      setAim(p);
    } else if (humanTurn() && state === 'ballInHand') {
      setGhost(p);
    }
  }

  function onMove(e) {
    if (!match) return;
    const p = pointerPos(e);
    if (aiming && state === 'aim') setAim(p);
    else if (humanTurn() && state === 'ballInHand') setGhost(p);
  }

  function onUp() {
    if (!match) return;
    aiming = false;
    if (humanTurn() && state === 'ballInHand' && ghost && ghost.valid) {
      placeCue(ghost.x, ghost.y);
      UI.toast('Bola posicionada — sua vez');
    }
  }

  function setAim(p) {
    const c = cue();
    const dx = p.x - c.x, dy = p.y - c.y;
    if (Math.hypot(dx, dy) <= 3) return;
    // modo taco: o dedo segura o taco atrás da branca, a mira vai pro lado oposto
    aimAngle = aimMode === 'stick' ? Math.atan2(-dy, -dx) : Math.atan2(dy, dx);
  }

  function setGhost(p) {
    // regra de bar: bola na mão só atrás da linha de saída
    const x = Math.max(R + 1, Math.min(HEAD_X, p.x));
    const y = Math.max(R + 1, Math.min(H - R - 1, p.y));
    ghost = { x, y, valid: PHYS.validSpot(balls, x, y) };
  }

  function nudgeAim(dir) {
    if (humanTurn() && state === 'aim' && !botAnim) aimAngle += dir * 0.0035;
  }

  // ---------- canvas ----------
  function ensureCanvas() {
    if (canvas) return;
    canvas = document.getElementById('game-canvas');
    canvas.width = 1800; canvas.height = 1000;
    ctx = canvas.getContext('2d');
    ctx.scale(2, 2);
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    PHYS.onPot = (b, p) => spawnPotFx(b.n, b.x, b.y, p);
    buildCache();
  }

  function buildCache() {
    // madeira
    const wood = ctx.createLinearGradient(0, 0, 0, 500);
    wood.addColorStop(0, '#7a4f26');
    wood.addColorStop(0.5, '#5a3719');
    wood.addColorStop(1, '#42260f');
    cache.wood = wood;
    // feltro azul com luz central (estilo 8 Ball Pool)
    const felt = ctx.createRadialGradient(450, 250, 60, 450, 250, 520);
    felt.addColorStop(0, '#2f83c2');
    felt.addColorStop(0.55, '#2470ad');
    felt.addColorStop(1, '#153f66');
    cache.felt = felt;
    // vinheta geral
    const vig = ctx.createRadialGradient(450, 250, 250, 450, 250, 620);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.45)');
    cache.vignette = vig;
  }

  function render() {
    if (!ctx || !match) return;
    ctx.clearRect(0, 0, 900, 500);
    ctx.save();
    if (shake > 0.05) ctx.translate((Math.random() * 2 - 1) * shake, (Math.random() * 2 - 1) * shake);
    drawTable();
    ctx.save();
    ctx.translate(M, M);
    // online: só mostra mira/taco na SUA vez (a do adversário fica escondida)
    const showAim = state === 'aim' && cue().active && (!match.online || humanTurn());
    if (state === 'ballInHand') {
      // ilumina a área de saída onde a branca pode ser posicionada
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(0, 0, HEAD_X, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 8]);
      ctx.beginPath();
      ctx.moveTo(HEAD_X, 0);
      ctx.lineTo(HEAD_X, H);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (showAim) drawGuide();
    drawTrail();
    for (const s of sinkAnims) drawSink(s);
    for (const b of balls) if (b.active) drawBall(b);
    drawParts();
    if (showAim) drawStick();
    if (strike) drawStrike();
    if (state === 'ballInHand' && ghost) drawGhostCue();
    ctx.restore();
    ctx.restore();
    ctx.fillStyle = cache.vignette;
    ctx.fillRect(0, 0, 900, 500);
  }

  function drawTrail() {
    for (const p of trail) {
      const a = p.life / 0.3;
      ctx.globalAlpha = a * 0.3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 0.85 * a, 0, 7);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawParts() {
    for (const p of parts) {
      if (p.flash) {
        const a = p.life / 0.3;
        const g = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, 30);
        g.addColorStop(0, `rgba(255,233,163,${0.55 * a})`);
        g.addColorStop(1, 'rgba(255,233,163,0)');
        ctx.beginPath();
        ctx.arc(p.x, p.y, 30, 0, 7);
        ctx.fillStyle = g;
        ctx.fill();
      } else {
        ctx.globalAlpha = Math.max(0, p.life / 0.45);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.5 + (p.big ? 1 : 0), 0, 7);
        ctx.fillStyle = p.col;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function rounded(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawTable() {
    // moldura de madeira
    rounded(2, 2, 896, 496, 30);
    ctx.fillStyle = cache.wood;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#241305';
    ctx.stroke();
    // filete dourado
    rounded(11, 11, 878, 478, 24);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(212,175,55,0.75)';
    ctx.stroke();
    // marcações (diamantes) na madeira
    ctx.fillStyle = 'rgba(240,220,160,0.8)';
    for (const fx of [0.25, 0.75]) {
      dot(M + W * fx, 27); dot(M + W * fx, 473);
    }
    for (const fy of [0.25, 0.5, 0.75]) {
      dot(27, M + H * fy); dot(873, M + H * fy);
    }
    // feltro
    ctx.fillStyle = cache.felt;
    ctx.fillRect(M - 16, M - 16, W + 32, H + 32);
    // logo no centro do feltro
    ctx.save();
    ctx.translate(M + W / 2, M + H / 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 58, 0, 7);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.font = '800 20px Rubik, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('SINUCA PRO', 0, 0);
    ctx.restore();
    // linha de saída e marca do rack
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(M + 200, M);
    ctx.lineTo(M + 200, M + H);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(M + 600, M + H / 2, 3, 0, 7);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fill();
    // tabelas (almofadas) com recorte nas caçapas
    ctx.save();
    ctx.translate(M, M);
    const c1 = '#1b5a8e', c2 = 'rgba(255,255,255,0.14)';
    cushion([[22, -16], [384, -16], [374, 0], [34, 0]], c1, c2, 'h');
    cushion([[416, -16], [778, -16], [766, 0], [426, 0]], c1, c2, 'h');
    cushion([[22, H + 16], [384, H + 16], [374, H], [34, H]], c1, c2, 'h');
    cushion([[416, H + 16], [778, H + 16], [766, H], [426, H]], c1, c2, 'h');
    cushion([[-16, 22], [-16, 378], [0, 366], [0, 34]], c1, c2, 'v');
    cushion([[W + 16, 22], [W + 16, 378], [W, 366], [W, 34]], c1, c2, 'v');
    ctx.restore();
    // caçapas com aro dourado
    for (const p of POCKETS) {
      const px = M + p.x, py = M + p.y;
      ctx.beginPath();
      ctx.arc(px, py, p.r + 4, 0, 7);
      ctx.fillStyle = '#caa14e';
      ctx.fill();
      const g = ctx.createRadialGradient(px, py, 2, px, py, p.r + 1);
      g.addColorStop(0, '#000');
      g.addColorStop(0.75, '#050a08');
      g.addColorStop(1, '#12241a');
      ctx.beginPath();
      ctx.arc(px, py, p.r + 1, 0, 7);
      ctx.fillStyle = g;
      ctx.fill();
    }
  }

  function dot(x, y) {
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, 7);
    ctx.fill();
  }

  function cushion(pts, fill, edge) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    // borda iluminada na face interna
    ctx.beginPath();
    ctx.moveTo(pts[3][0], pts[3][1]);
    ctx.lineTo(pts[2][0], pts[2][1]);
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function drawBall(b) {
    const { x, y } = b;
    // sombra suave
    const sh = ctx.createRadialGradient(x + 2, y + 3, 1, x + 2, y + 3, R + 4);
    sh.addColorStop(0, 'rgba(0,0,0,0.4)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.arc(x + 2, y + 3, R + 4, 0, 7);
    ctx.fillStyle = sh;
    ctx.fill();
    // corpo com volume
    const base = (b.n === 0 || b.n > 8) ? '#f7f3e7' : colorOf(b.n);
    const g = ctx.createRadialGradient(x - 3.5, y - 4.5, 1.5, x, y, R + 1.5);
    g.addColorStop(0, shade(base, 0.5));
    g.addColorStop(0.45, base);
    g.addColorStop(1, shade(base, -0.45));
    ctx.beginPath();
    ctx.arc(x, y, R, 0, 7);
    ctx.fillStyle = g;
    ctx.fill();
    // rolamento visual: o padrão da bola desliza na direção do movimento
    const rolling = b.vx !== 0 || b.vy !== 0 || !!b.lerpMoving;
    const off = Math.sin((b.roll || 0) % (Math.PI * 2)) * R * 0.6;
    const ra = b.rollA || 0;
    // faixa das listradas
    if (b.n > 8) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, R, 0, 7);
      ctx.clip();
      const c = colorOf(b.n);
      if (rolling) {
        ctx.translate(x, y);
        ctx.rotate(ra);
        ctx.fillStyle = c;
        ctx.fillRect(off - R * 0.55, -R - 1, R * 1.1, 2 * R + 2);
      } else {
        const bg = ctx.createLinearGradient(x, y - R * 0.55, x, y + R * 0.55);
        bg.addColorStop(0, shade(c, 0.25));
        bg.addColorStop(0.5, c);
        bg.addColorStop(1, shade(c, -0.3));
        ctx.fillStyle = bg;
        ctx.fillRect(x - R, y - R * 0.55, 2 * R, R * 1.1);
      }
      ctx.restore();
    }
    // número (rola junto com a bola)
    if (b.n > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, R, 0, 7);
      ctx.clip();
      const nx = x + (rolling ? Math.cos(ra) * off : 0);
      const ny = y + (rolling ? Math.sin(ra) * off : 0);
      ctx.beginPath();
      ctx.arc(nx, ny, 4.6, 0, 7);
      ctx.fillStyle = '#fdfcf7';
      ctx.fill();
      ctx.fillStyle = '#1c1c1c';
      ctx.font = '700 6.5px Rubik, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.n, nx, ny + 0.5);
      ctx.restore();
    } else {
      // pontinho vermelho da bola branca (mostra o giro)
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, R, 0, 7);
      ctx.clip();
      const nx = x + (rolling ? Math.cos(ra) * off : R * 0.35);
      const ny = y + (rolling ? Math.sin(ra) * off : -R * 0.3);
      ctx.beginPath();
      ctx.arc(nx, ny, 1.8, 0, 7);
      ctx.fillStyle = 'rgba(200,40,40,0.85)';
      ctx.fill();
      ctx.restore();
    }
    // brilho (reflexo da luz)
    ctx.save();
    ctx.translate(x - 3, y - 4.2);
    ctx.rotate(-0.5);
    ctx.scale(1, 0.62);
    const gl = ctx.createRadialGradient(0, 0, 0.5, 0, 0, 4.5);
    gl.addColorStop(0, 'rgba(255,255,255,0.85)');
    gl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.arc(0, 0, 4.5, 0, 7);
    ctx.fillStyle = gl;
    ctx.fill();
    ctx.restore();
  }

  function drawSink(s) {
    const k = Math.min(1, s.t / 0.28);
    const x = s.x + (s.px - s.x) * k;
    const y = s.y + (s.py - s.y) * k;
    const c = s.n === 0 ? '#f7f3e7' : colorOf(s.n);
    ctx.globalAlpha = 1 - k * 0.85;
    ctx.beginPath();
    ctx.arc(x, y, R * (1 - 0.65 * k), 0, 7);
    ctx.fillStyle = c;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawGuide() {
    const c = cue();
    const res = PHYS.cast(c.x, c.y, aimAngle, balls);
    ctx.setLineDash([5, 7]);
    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(res.x, res.y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (res.type === 'ball') {
      // bola fantasma no ponto de contato
      ctx.beginPath();
      ctx.arc(res.x, res.y, R, 0, 7);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      const t = res.ball;
      const nx = (t.x - res.x), ny = (t.y - res.y);
      const nd = Math.hypot(nx, ny) || 1;
      // direção da bola alvo
      ctx.strokeStyle = 'rgba(255,235,120,0.9)';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(t.x + nx / nd * 46, t.y + ny / nd * 46);
      ctx.stroke();
      // desvio da bola branca após o contato
      const dx = Math.cos(aimAngle), dy = Math.sin(aimAngle);
      const dotp = dx * nx / nd + dy * ny / nd;
      const tx = dx - dotp * nx / nd, ty = dy - dotp * ny / nd;
      const tl = Math.hypot(tx, ty);
      if (tl > 0.08) {
        ctx.strokeStyle = 'rgba(160,215,255,0.8)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(res.x, res.y);
        ctx.lineTo(res.x + tx / tl * 32, res.y + ty / tl * 32);
        ctx.stroke();
      }
    }
  }

  function drawStick() {
    const c = cue();
    const pull = 16 + (botAnim ? 30 * Math.min(1, botAnim.t / botAnim.dur) : power * 0.3);
    stickAt(c.x, c.y, aimAngle, pull, 1);
  }

  // taco disparando na hora da tacada
  function drawStrike() {
    const t = strike.t;
    let pull, alpha;
    if (t < 0.08) {
      pull = strike.pull0 * (1 - t / 0.08);
      alpha = 1;
    } else {
      pull = 0;
      alpha = Math.max(0, 1 - (t - 0.08) / 0.2);
    }
    stickAt(strike.x, strike.y, strike.angle, pull, alpha);
  }

  function stickAt(cx, cy, angle, pull, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    const x0 = -(R + 4 + pull);
    // sombra do taco
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath();
    ctx.moveTo(x0, 2);
    ctx.lineTo(x0 - 195, 6);
    ctx.lineTo(x0 - 195, 8.5);
    ctx.lineTo(x0, 4.5);
    ctx.closePath();
    ctx.fill();
    // corpo afunilado
    const wg = ctx.createLinearGradient(x0, 0, x0 - 195, 0);
    wg.addColorStop(0, '#eed4a3');
    wg.addColorStop(0.4, '#c89355');
    wg.addColorStop(0.75, '#6b4423');
    wg.addColorStop(1, '#2e1c0c');
    ctx.beginPath();
    ctx.moveTo(x0, -2.2);
    ctx.lineTo(x0 - 195, -4.8);
    ctx.lineTo(x0 - 195, 4.8);
    ctx.lineTo(x0, 2.2);
    ctx.closePath();
    ctx.fillStyle = wg;
    ctx.fill();
    // anel decorativo
    ctx.fillStyle = '#d4af37';
    ctx.fillRect(x0 - 140, -4.1, 4, 8.2);
    // ferrule (ponteira clara) + sola azul
    ctx.fillStyle = '#f2ead7';
    ctx.fillRect(x0 - 8, -2.4, 8, 4.8);
    ctx.fillStyle = '#3f74a8';
    ctx.fillRect(x0 - 1, -2.2, 3, 4.4);
    ctx.restore();
  }

  function drawGhostCue() {
    ctx.beginPath();
    ctx.arc(ghost.x, ghost.y, R, 0, 7);
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = ghost.valid ? 'rgba(255,255,255,0.9)' : 'rgba(255,80,80,0.9)';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ---------- dados para o HUD ----------
  function getHud() {
    if (!match) return null;
    return {
      mode: match.mode,
      stake: match.stake,
      bestOf: match.bestOf,
      wins: match.wins,
      gameNum: match.gameNum,
      online: match.online,
      localSeat: match.localSeat,
      current,
      state,
      lowest: match.mode === '9ball' ? lowest() : null,
      nine: match.mode === '9ball' ? balls.filter(b => b.active && b.n > 0).map(b => b.n) : null,
      three: match.mode === 'tresbolas' ? balls.filter(b => b.active && b.n > 0).map(b => b.n) : null,
      humanCanAct: humanTurn() && !botAnim && (state === 'aim' || state === 'ballInHand'),
      players: match.players.map((p, i) => ({
        name: p.name,
        type: p.type,
        group: p.group,
        balls: p.group ? balls.filter(b => b.active && groupOf(b.n) === p.group).map(b => b.n) : null,
        info: match.mode === '9ball' ? ''
          : match.mode === 'tresbolas' ? `⚫ ${match.potCount[i]} de 2 bolas`
          : openTable ? 'Mesa aberta'
          : remaining(p.group) === 0 ? `Na bola ${moneyBall()}!` : '',
      })),
    };
  }

  return {
    start, stop, nextGame, getHud, nudgeAim, humanShoot,
    setPower: v => { power = v; },
    setSpin: (x, y) => { spin = { x, y }; },
    getSpin: () => spin,
    // tremida de tela conforme a força do impacto
    impact: (v, kind) => {
      if (kind === 'ball' && v > 600) shake = Math.min(8, Math.max(shake, (v - 600) / 140));
      else if (kind === 'pot') shake = Math.max(shake, 2.2);
    },
    // ---- online ----
    netShot, netSnap, netSync, netPlace, netAim, netEnd, nextGameOnline, resumeShare,
    isNetAuth: () => !!(match && match.online && netAuth),
    makeRack: mode => rack(mode || '8ball').map(b => ({ n: b.n, x: b.x, y: b.y })),
    // usado pelos testes automatizados
    debugBalls: () => balls.map(b => ({ n: b.n, x: b.x, y: b.y, active: b.active })),
  };
})();
