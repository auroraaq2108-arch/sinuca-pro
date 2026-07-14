// physics.js — motor de física da sinuca (bolas, tabelas, caçapas, efeito)
//
// Modelo de bola: cada bola guarda velocidade linear (vx,vy) e velocidade
// angular (wx,wy,wz). wx/wy é o eixo de rotação "deitado" na mesa (o que dá
// o efeito de seguir/puxar — topspin/backspin); wz é a rotação em torno do
// eixo vertical (o efeito lateral / faca). Isso é física real de bilhar
// simplificada (esfera rígida, sem massa — ela se cancela nas equações):
//   ponto de contato com o pano desliza com velocidade u = (vx - R·wy, vy + R·wx)
//   enquanto |u| > 0 a bola "desliza" (atrito forte, muda direção e trava a
//   'seguida'/'puxada'); quando |u| ≈ 0 ela "rola" (atrito fraco, só perde
//   velocidade aos poucos, sem mais deslizar) — é isso que faz uma tacada
//   puxada (backspin) frear, "sentar" e voltar, e uma seguida (topspin)
//   acelerar/curvar depois do impacto, exatamente como na mesa de verdade.
const PHYS = (() => {
  const W = 800, H = 400;   // área de jogo (feltro), em unidades do mundo
  const R = 10;             // raio da bola
  const SLIDE_DECEL = 420;  // atrito de deslize (bola "patinando", com efeito ainda ativo)
  const ROLL_DECEL = 170;   // atrito de rolamento (bola já rolando "limpa")
  const SLIP_EPS = 6;       // abaixo disso o deslize é tratado como zero (rolamento puro)
  const STOP_V = 7;         // abaixo disso a bola para de vez
  const E_BALL = 0.95;      // restituição bola-bola
  const E_CUSH = 0.78;      // restituição na tabela
  const MAX_V = 1500;       // velocidade máxima da tacada
  const CUSH_GRIP = 0.16;   // quanto o efeito lateral desvia a bola ao bater na tabela
  const CUSH_SPIN_DECAY = 0.45; // quanto do efeito lateral "gruda" na tabela (o resto se perde)

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
    b.wx = b.wy = b.wz = 0;
    if (ev) {
      if (b.n === 0) ev.cuePotted = true;
      else ev.potted.push(b.n);
    }
    if (api.onPot) api.onPot(b, pocket || nearestPocket(b.x, b.y));
    if (api.onImpact) api.onImpact(1, 'pot');
  }

  // efeito lateral: desvia a bola ao quicar na tabela (a tabela "agarra" um
  // pouco do giro em torno do eixo vertical e devolve como desvio lateral)
  function sideSpinBounce(b, axis, sign) {
    if (!b.wz) return;
    const kick = sign * b.wz * R * CUSH_GRIP;
    if (axis === 'x') b.vy += kick; else b.vx += kick;
    b.wz *= CUSH_SPIN_DECAY;
    if (Math.abs(b.wz) < 0.02) b.wz = 0;
  }

  // atrito + giro: um substep de integração do rolamento/deslize de cada bola
  function integrateSpin(balls, h) {
    for (const b of balls) {
      if (!b.active) continue;
      const ux = b.vx - R * b.wy, uy = b.vy + R * b.wx;
      const uMag = Math.hypot(ux, uy);
      if (uMag > SLIP_EPS) {
        // deslizando: atrito forte muda velocidade E giro ao mesmo tempo,
        // caminhando pro rolamento puro (é o que dá a "puxada"/"seguida")
        const ix = ux / uMag, iy = uy / uMag;
        const dv = SLIDE_DECEL * h;
        const dw = (5 * SLIDE_DECEL * h) / (2 * R);
        const nvx = b.vx - dv * ix, nvy = b.vy - dv * iy;
        const nwx = b.wx - dw * iy, nwy = b.wy + dw * ix;
        const nux = nvx - R * nwy, nuy = nvy + R * nwx;
        if (ux * nux + uy * nuy <= 0) { b.wy = b.vx / R; b.wx = -b.vy / R; } // cruzou o zero: trava no rolamento
        else { b.vx = nvx; b.vy = nvy; b.wx = nwx; b.wy = nwy; }
      } else {
        // rolando limpo: atrito fraco, só perde velocidade aos poucos
        const v = Math.hypot(b.vx, b.vy);
        if (v > 0) {
          const nv = Math.max(0, v - ROLL_DECEL * h);
          const k = nv / v;
          b.vx *= k; b.vy *= k;
          if (nv < STOP_V) { b.vx = 0; b.vy = 0; b.wx = 0; b.wy = 0; b.wz = 0; }
          else { b.wy = b.vx / R; b.wx = -b.vy / R; }
        } else {
          b.wx = 0; b.wy = 0;
        }
      }
    }
  }

  // colisão bola-bola já em contato exato (usado pela CCD e por overlaps residuais)
  function resolveBallHit(a, c, ev) {
    const dx = c.x - a.x, dy = c.y - a.y;
    const d = Math.hypot(dx, dy) || 2 * R;
    const nx = dx / d, ny = dy / d;
    const rel = (a.vx - c.vx) * nx + (a.vy - c.vy) * ny;
    if (rel <= 0) return;
    const jm = rel * (1 + E_BALL) / 2;
    a.vx -= jm * nx; a.vy -= jm * ny;
    c.vx += jm * nx; c.vy += jm * ny;
    const cueBall = a.n === 0 ? a : c.n === 0 ? c : null;
    if (cueBall && ev && ev.firstHit == null) ev.firstHit = (cueBall === a ? c : a).n;
    if (api.onImpact) api.onImpact(rel, 'ball');
  }

  // separa bolas que já começam o substep sobrepostas (raro: jitter da mesa
  // recém-armada ou resíduo numérico) antes de rodar a detecção contínua
  function resolveOverlaps(balls, ev) {
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
        resolveBallHit(a, c, ev);
      }
    }
  }

  // move todas as bolas pelo substep, mas com detecção CONTÍNUA de colisão
  // bola-bola: acha o instante exato em que duas bolas se tocam (não só o
  // estado no fim do passo) — sem isso, tacadas fortes (ex: o break) podem
  // fazer duas bolas rápidas se atravessarem sem colidir.
  function moveWithCCD(balls, h, ev) {
    let remaining = h, guard = 0;
    while (remaining > 1e-9 && guard++ < 12) {
      let bestT = remaining, bestA = null, bestC = null;
      for (let i = 0; i < balls.length; i++) {
        const a = balls[i];
        if (!a.active) continue;
        for (let j = i + 1; j < balls.length; j++) {
          const c = balls[j];
          if (!c.active) continue;
          const px = c.x - a.x, py = c.y - a.y;
          const vx = c.vx - a.vx, vy = c.vy - a.vy;
          const vv = vx * vx + vy * vy;
          if (vv < 1e-6) continue;
          const pv = px * vx + py * vy;
          if (pv >= 0) continue; // se afastando, não colide nesse trecho
          const pp = px * px + py * py, rr = 4 * R * R;
          const disc = pv * pv - vv * (pp - rr);
          if (disc < 0) continue;
          const t = (-pv - Math.sqrt(disc)) / vv;
          if (t >= 0 && t < bestT) { bestT = t; bestA = a; bestC = c; }
        }
      }
      for (const b of balls) { if (b.active) { b.x += b.vx * bestT; b.y += b.vy * bestT; } }
      remaining -= bestT;
      if (bestA && bestC) resolveBallHit(bestA, bestC, ev);
      else break;
    }
  }

  function sub(balls, h, ev) {
    integrateSpin(balls, h);       // atrito + giro (rolar/deslizar) — não mexe em posição
    resolveOverlaps(balls, ev);    // desgruda bolas que já nasceram encostadas
    moveWithCCD(balls, h, ev);     // move + colisão bola-bola sem atravessar
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
    return balls.some(b => b.active && (b.vx !== 0 || b.vy !== 0 || b.wx !== 0 || b.wy !== 0));
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

  // velocidade angular inicial a partir do ponto de tacada (efeito/spin,
  // cada eixo de -1 a 1) e da velocidade de saída da tacada — física real
  // de "onde o taco bate na bola" (deslocado do centro cria giro).
  function spinToOmega(spinX, spinY, v0, angle) {
    const OFFSET_FRAC = 0.5; // deslocamento máx. do taco = metade do raio
    const CSPIN = OFFSET_FRAC * 2.5;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const wFollow = spinY * CSPIN * v0 / R; // eixo perpendicular à tacada (segue/puxa)
    const wSide = spinX * CSPIN * v0 / R;   // eixo vertical (efeito lateral)
    return { wx: -wFollow * dy, wy: wFollow * dx, wz: wSide };
  }

  Object.assign(api, { W, H, R, MAX_V, POCKETS, step, anyMoving, cast, pathClear, validSpot, spinToOmega, onImpact: null, onPot: null });
  return api;
})();
