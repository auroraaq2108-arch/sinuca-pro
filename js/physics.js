// physics.js — motor de física da sinuca (bolas, tabelas, caçapas, efeito)
const PHYS = (() => {
  const W = 800, H = 400;   // área de jogo (feltro), em unidades do mundo
  const R = 10;             // raio da bola
  const FRICTION = 170;     // desaceleração do rolamento (unid/s²)
  const STOP_V = 7;         // abaixo disso a bola para
  const E_BALL = 0.95;      // restituição bola-bola
  const E_CUSH = 0.78;      // restituição na tabela
  const MAX_V = 1500;       // velocidade máxima da tacada

  const POCKETS = [
    { x: 2,     y: 2,     r: 17 },
    { x: W - 2, y: 2,     r: 17 },
    { x: 2,     y: H - 2, r: 17 },
    { x: W - 2, y: H - 2, r: 17 },
    { x: W / 2, y: -7,    r: 16 },
    { x: W / 2, y: H + 7, r: 16 },
  ];

  const api = {};

  function nearMouth(x, y) {
    for (const p of POCKETS) {
      if (Math.hypot(x - p.x, y - p.y) < p.r + 4) return true;
    }
    return false;
  }

  function nearestPocket(x, y) {
    let best = POCKETS[0], bd = Infinity;
    for (const p of POCKETS) {
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  function pot(b, ev, pocket) {
    b.active = false;
    b.vx = b.vy = 0;
    if (ev) {
      if (b.n === 0) ev.cuePotted = true;
      else ev.potted.push(b.n);
    }
    if (api.onPot) api.onPot(b, pocket || nearestPocket(b.x, b.y));
    if (api.onImpact) api.onImpact(1, 'pot');
  }

  // efeito lateral: desvia a bola ao quicar na tabela
  function sideSpinBounce(b, axis, sign) {
    if (!b.spinX) return;
    if (axis === 'x') b.vy += sign * b.spinX * Math.abs(b.vx) * 0.6;
    else b.vx += sign * b.spinX * Math.abs(b.vy) * 0.6;
    b.spinX *= 0.45;
  }

  function sub(balls, h, ev) {
    // integração + atrito
    for (const b of balls) {
      if (!b.active) continue;
      const v = Math.hypot(b.vx, b.vy);
      if (v > 0) {
        const nv = Math.max(0, v - FRICTION * h);
        const k = v > 0 ? nv / v : 0;
        b.vx *= k; b.vy *= k;
        if (nv < STOP_V) { b.vx = 0; b.vy = 0; }
      }
      b.x += b.vx * h;
      b.y += b.vy * h;
    }
    // colisões bola-bola (massas iguais)
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (!a.active) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const c = balls[j];
        if (!c.active) continue;
        const dx = c.x - a.x, dy = c.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d === 0 || d >= 2 * R) continue;
        const nx = dx / d, ny = dy / d;
        const overlap = 2 * R - d;
        a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
        c.x += nx * overlap / 2; c.y += ny * overlap / 2;
        const rel = (a.vx - c.vx) * nx + (a.vy - c.vy) * ny;
        if (rel <= 0) continue;
        const jm = rel * (1 + E_BALL) / 2;
        a.vx -= jm * nx; a.vy -= jm * ny;
        c.vx += jm * nx; c.vy += jm * ny;
        // primeiro contato da branca: registra e aplica o efeito (seguir/puxar)
        const cueBall = a.n === 0 ? a : c.n === 0 ? c : null;
        if (cueBall && ev && ev.firstHit == null) {
          ev.firstHit = (cueBall === a ? c : a).n;
          const s = cueBall.spinY || 0;
          if (s) {
            const dir = cueBall === a ? 1 : -1; // normal aponta de a para c
            cueBall.vx += nx * dir * s * rel * 0.38;
            cueBall.vy += ny * dir * s * rel * 0.38;
            cueBall.spinY = 0;
          }
        }
        if (api.onImpact) api.onImpact(rel, 'ball');
      }
    }
    // caçapas e tabelas
    for (const b of balls) {
      if (!b.active) continue;
      for (const p of POCKETS) {
        if (Math.hypot(b.x - p.x, b.y - p.y) < p.r) { pot(b, ev, p); break; }
      }
      if (!b.active) continue;
      if (!nearMouth(b.x, b.y)) {
        if (b.x < R)     { b.x = R;     if (b.vx < 0) { b.vx = -b.vx * E_CUSH; sideSpinBounce(b, 'x', -1); if (api.onImpact) api.onImpact(Math.abs(b.vx), 'cushion'); } }
        if (b.x > W - R) { b.x = W - R; if (b.vx > 0) { b.vx = -b.vx * E_CUSH; sideSpinBounce(b, 'x', 1);  if (api.onImpact) api.onImpact(Math.abs(b.vx), 'cushion'); } }
        if (b.y < R)     { b.y = R;     if (b.vy < 0) { b.vy = -b.vy * E_CUSH; sideSpinBounce(b, 'y', 1);  if (api.onImpact) api.onImpact(Math.abs(b.vy), 'cushion'); } }
        if (b.y > H - R) { b.y = H - R; if (b.vy > 0) { b.vy = -b.vy * E_CUSH; sideSpinBounce(b, 'y', -1); if (api.onImpact) api.onImpact(Math.abs(b.vy), 'cushion'); } }
      } else if (b.x < -2 * R || b.x > W + 2 * R || b.y < -2 * R || b.y > H + 2 * R) {
        pot(b, ev); // saiu da mesa pela boca da caçapa
      }
    }
  }

  function step(balls, dt, ev) {
    let t = 0;
    const hMax = 1 / 240;
    while (t < dt) {
      const h = Math.min(hMax, dt - t);
      sub(balls, h, ev);
      t += h;
    }
  }

  function anyMoving(balls) {
    return balls.some(b => b.active && (b.vx !== 0 || b.vy !== 0));
  }

  // traça um raio a partir da bola branca: primeira bola ou tabela atingida
  function cast(x, y, angle, balls) {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    let bestT = Infinity, hit = null;
    for (const b of balls) {
      if (!b.active || b.n === 0) continue;
      const px = b.x - x, py = b.y - y;
      const proj = px * dx + py * dy;
      if (proj <= 0) continue;
      const per2 = px * px + py * py - proj * proj;
      const rr = 4 * R * R;
      if (per2 >= rr) continue;
      const t = proj - Math.sqrt(rr - per2);
      if (t > 0 && t < bestT) { bestT = t; hit = b; }
    }
    let tw = Infinity;
    if (dx > 1e-9)  tw = Math.min(tw, (W - R - x) / dx);
    if (dx < -1e-9) tw = Math.min(tw, (R - x) / dx);
    if (dy > 1e-9)  tw = Math.min(tw, (H - R - y) / dy);
    if (dy < -1e-9) tw = Math.min(tw, (R - y) / dy);
    if (hit && bestT < tw) return { type: 'ball', x: x + dx * bestT, y: y + dy * bestT, ball: hit, t: bestT };
    return { type: 'cushion', x: x + dx * tw, y: y + dy * tw, t: tw };
  }

  // caminho livre entre dois pontos (para a IA e dicas)
  function pathClear(ax, ay, bx, by, balls, excl) {
    const ux = bx - ax, uy = by - ay;
    const L = Math.hypot(ux, uy) || 1;
    const nx = ux / L, ny = uy / L;
    for (const b of balls) {
      if (!b.active || excl.has(b.n)) continue;
      const px = b.x - ax, py = b.y - ay;
      const t = Math.max(0, Math.min(L, px * nx + py * ny));
      if (Math.hypot(px - nx * t, py - ny * t) < 2 * R - 1) return false;
    }
    return true;
  }

  // posição válida para colocar a bola branca
  function validSpot(balls, x, y) {
    if (x < R + 1 || x > W - R - 1 || y < R + 1 || y > H - R - 1) return false;
    for (const p of POCKETS) {
      if (Math.hypot(x - p.x, y - p.y) < p.r + 4) return false;
    }
    for (const b of balls) {
      if (b.active && Math.hypot(b.x - x, b.y - y) < 2 * R + 1) return false;
    }
    return true;
  }

  Object.assign(api, { W, H, R, MAX_V, POCKETS, step, anyMoving, cast, pathClear, validSpot, onImpact: null, onPot: null });
  return api;
})();
