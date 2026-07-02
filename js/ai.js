// ai.js — bots com três níveis de habilidade
// A precisão vem do "ruído" aplicado na mira: quanto menor, melhor o bot.
const AI = (() => {
  const LEVELS = {
    iniciante: { noise: 0.045, pnoise: 0.28, blunder: 0.35, topN: 99 },
    medio:     { noise: 0.016, pnoise: 0.14, blunder: 0.08, topN: 2 },
    pro:       { noise: 0.005, pnoise: 0.05, blunder: 0,    topN: 1 },
  };

  function gauss() {
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // todas as tacadas possíveis: para cada bola legal, cada caçapa alcançável
  function candidates(cuePos, balls, targets) {
    const R = PHYS.R;
    const list = [];
    for (const t of balls) {
      if (!t.active || !targets.includes(t.n)) continue;
      for (const p of PHYS.POCKETS) {
        const dpx = p.x - t.x, dpy = p.y - t.y;
        const dp = Math.hypot(dpx, dpy);
        if (dp < 1) continue;
        // "bola fantasma": onde a branca precisa estar no momento do contato
        const gx = t.x - (dpx / dp) * 2 * R;
        const gy = t.y - (dpy / dp) * 2 * R;
        const dgx = gx - cuePos.x, dgy = gy - cuePos.y;
        const dg = Math.hypot(dgx, dgy);
        if (dg < 1) continue;
        const cos = (dgx * dpx + dgy * dpy) / (dg * dp);
        if (cos < 0.25) continue; // corte fino demais, impossível
        const excl = new Set([0, t.n]);
        if (!PHYS.pathClear(cuePos.x, cuePos.y, gx, gy, balls, excl)) continue;
        if (!PHYS.pathClear(t.x, t.y, p.x, p.y, balls, excl)) continue;
        const dist = dg + dp;
        const score = cos * 2 - dist / 900;
        const power = Math.min(PHYS.MAX_V, (240 + dist * 1.25) / Math.max(0.35, cos));
        list.push({ angle: Math.atan2(dgy, dgx), power, score });
      }
    }
    list.sort((a, b) => b.score - a.score);
    return list;
  }

  function chooseShot(cueBall, balls, targets, levelName) {
    const L = LEVELS[levelName] || LEVELS.medio;
    const cands = candidates(cueBall, balls, targets);
    let shot;
    if (!cands.length) {
      // sem tacada boa: bate na bola legal mais próxima (jogada de segurança)
      let best = null, bd = Infinity;
      for (const b of balls) {
        if (!b.active || !targets.includes(b.n)) continue;
        const d = Math.hypot(b.x - cueBall.x, b.y - cueBall.y);
        if (d < bd) { bd = d; best = b; }
      }
      if (!best) return { angle: Math.random() * Math.PI * 2, power: 400 };
      shot = { angle: Math.atan2(best.y - cueBall.y, best.x - cueBall.x), power: 320 + bd * 0.5 };
    } else {
      const n = Math.min(L.topN, cands.length);
      shot = cands[(Math.random() * n) | 0];
      if (Math.random() < L.blunder) shot = cands[(Math.random() * cands.length) | 0];
    }
    const noise = L.noise * (Math.random() < L.blunder ? 2 : 1);
    return {
      angle: shot.angle + gauss() * noise,
      power: Math.max(220, Math.min(PHYS.MAX_V, shot.power * (1 + gauss() * L.pnoise))),
    };
  }

  // bola na mão: escolhe a melhor posição ATRÁS da linha de saída (regra de bar)
  function placeCueBall(balls, targets, levelName) {
    const spots = [];
    for (const x of [50, 90, 130, 170, 198]) {
      for (const y of [70, 130, 200, 270, 330]) spots.push({ x, y });
    }
    let best = null;
    for (const s of spots) {
      if (!PHYS.validSpot(balls, s.x, s.y)) continue;
      const c = candidates(s, balls, targets);
      const sc = c.length ? c[0].score : -9;
      if (!best || sc > best.sc) best = { x: s.x, y: s.y, sc };
    }
    return best || { x: 150, y: 200 };
  }

  return { chooseShot, placeCueBall };
})();
