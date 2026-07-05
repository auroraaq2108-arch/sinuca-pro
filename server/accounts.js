// accounts.js — contas de jogador (email/senha), carteira e ranking no servidor.
// Sem dependências externas: senha via scrypt (embutido no Node).
// Armazenamento:
//   - se SUPABASE_URL + SUPABASE_KEY estiverem no ambiente → banco Supabase (PERMANENTE)
//   - senão → arquivo data/accounts.json (efêmero na nuvem grátis; some no restart)
const crypto = require('crypto');
const https = require('https');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const scrypt = promisify(crypto.scrypt);
const TOKEN_TTL = 30 * 24 * 3600 * 1000; // sessão vale 30 dias

const DIR = path.join(__dirname, 'data');
const FILE = path.join(DIR, 'accounts.json');

// aceita a URL base OU com /rest/v1 no fim (tira o que sobra pra não duplicar)
const SUPA_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const SUPA_KEY = process.env.SUPABASE_KEY || '';
const USE_SUPA = !!(SUPA_URL && SUPA_KEY);

let db = { users: {}, byEmail: {}, byRef: {} };

const sessions = new Map(); // token -> { id, exp } (em memória; cai no restart)
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp < now) sessions.delete(t);
}, 3600 * 1000).unref?.();

// ---- Supabase via API REST (sem instalar nada) ----
function supaReq(method, pathq, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPA_URL + '/rest/v1/' + pathq);
    const mod = u.protocol === 'http:' ? require('http') : https;
    const data = body ? JSON.stringify(body) : null;
    // chave nova (sb_secret_...) autentica pelo header apikey; chave antiga (JWT eyJ...)
    // também precisa do Authorization Bearer. Cobre os dois formatos.
    const isJwt = SUPA_KEY.startsWith('eyJ');
    const req = mod.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      headers: {
        apikey: SUPA_KEY,
        ...(isJwt ? { Authorization: 'Bearer ' + SUPA_KEY } : {}),
        'Content-Type': 'application/json',
        ...(method === 'POST' ? { Prefer: 'resolution=merge-duplicates,return=minimal' } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(d ? JSON.parse(d) : null); } catch (e) { resolve(null); } }
        else reject(new Error('supabase ' + res.statusCode + ': ' + d.slice(0, 200)));
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function indexUser(u) { db.users[u.id] = u; db.byEmail[u.email] = u.id; db.byRef[u.refCode] = u.id; }

// carrega tudo pra memória no início (o servidor espera o `ready` antes de aceitar jogadores)
const ready = (async () => {
  if (USE_SUPA) {
    try {
      const rows = await supaReq('GET', 'users?select=data');
      for (const row of rows || []) if (row.data && row.data.id) indexUser(row.data);
      console.log('Supabase conectado — ' + Object.keys(db.users).length + ' contas carregadas (PERMANENTE).');
    } catch (e) {
      console.log('ERRO ao conectar no Supabase (' + e.message + '). Confira SUPABASE_URL/SUPABASE_KEY.');
    }
  } else {
    try {
      const loaded = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      db = { users: loaded.users || {}, byEmail: loaded.byEmail || {}, byRef: loaded.byRef || {} };
    } catch (e) { /* primeiro uso */ }
    console.log('Armazenamento em ARQUIVO (efêmero na nuvem grátis). Configure SUPABASE_URL/SUPABASE_KEY pra permanente.');
  }
})();

// grava a mudança de um usuário (Supabase: upsert por usuário · arquivo: salva o conjunto)
const dirty = new Set();
let flushTimer = null, fileTimer = null;
function touch(u) {
  if (USE_SUPA) {
    dirty.add(u.id);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 400);
  } else {
    clearTimeout(fileTimer);
    fileTimer = setTimeout(() => {
      try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db)); }
      catch (e) { console.log('não consegui salvar contas:', e.message); }
    }, 300);
  }
}
async function flush() {
  const ids = [...dirty]; dirty.clear();
  for (const id of ids) {
    const u = db.users[id];
    if (!u) continue;
    try { await supaReq('POST', 'users', { id, data: u }); }
    catch (e) { console.log('Supabase save falhou (' + e.message + '), tento de novo'); dirty.add(id); }
  }
  if (dirty.size) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 3000); }
}
// grava JÁ e espera (usado no cadastro, pra conta nova nunca se perder)
async function persistNow(u) {
  if (USE_SUPA) { try { await supaReq('POST', 'users', { id: u.id, data: u }); } catch (e) { touch(u); } }
  else touch(u);
}

// hash de senha assíncrono (não trava o servidor) — scrypt do próprio Node
async function hashPw(pw, salt) { return (await scrypt(pw, salt, 64)).toString('hex'); }
// comparação em tempo constante (evita descobrir a senha pelo tempo de resposta)
function safeEq(a, b) {
  const ba = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function newToken(id) {
  const t = crypto.randomBytes(24).toString('hex');
  sessions.set(t, { id, exp: Date.now() + TOKEN_TTL });
  return t;
}
const uid = () => 'u' + crypto.randomBytes(8).toString('hex');
function refCode() {
  const C = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = ''; for (let i = 0; i < 6; i++) c += C[(Math.random() * C.length) | 0]; } while (db.byRef[c]);
  return c;
}

const normEmail = e => String(e || '').trim().toLowerCase();
const cleanNick = n => String(n || '').trim().slice(0, 14);
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// dados que o cliente pode ver (nunca a senha/salt)
function pub(u) {
  return {
    id: u.id, nick: u.nick, email: u.email,
    coins: u.coins, w: u.w, l: u.l, pts: u.pts,
    refCode: u.refCode, refCount: u.refCount || 0, refEarn: u.refEarn || 0,
  };
}

async function register({ email, password, nick, ref }) {
  email = normEmail(email);
  nick = cleanNick(nick);
  password = String(password || '');
  if (!validEmail(email) || email.length > 120) return { err: 'Email inválido' };
  if (password.length < 6) return { err: 'A senha precisa de pelo menos 6 caracteres' };
  if (password.length > 200) return { err: 'Senha muito longa' };
  if (!nick) return { err: 'Escolha um apelido' };
  if (db.byEmail[email]) return { err: 'Esse email já está cadastrado — faça login' };

  const id = uid();
  const salt = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const refBy = ref && db.byRef[String(ref).toUpperCase()] ? String(ref).toUpperCase() : null;
  const user = {
    id, email, nick, salt, pass: await hashPw(password, salt),
    coins: 500, w: 0, l: 0, pts: 1000,
    hours: 0, logins: 1, createdAt: now, lastLogin: now,
    refCode: refCode(), refBy, refCount: 0, refEarn: 0,
  };
  db.users[id] = user;
  db.byEmail[email] = id;
  db.byRef[user.refCode] = id;
  // bônus de indicação: quem trouxe ganha moedas de teste + contador
  if (refBy) {
    const host = db.users[db.byRef[refBy]];
    if (host) { host.refCount = (host.refCount || 0) + 1; host.refEarn = (host.refEarn || 0) + 100; host.coins += 100; touch(host); }
  }
  await persistNow(user); // conta nova é gravada JÁ (não pode se perder)
  return { token: newToken(id), user: pub(user) };
}

async function login({ email, password }) {
  email = normEmail(email);
  password = String(password || '');
  const id = db.byEmail[email];
  const user = id && db.users[id];
  // sempre calcula um hash (mesmo sem usuário) pra não vazar quem existe pelo tempo
  const salt = user ? user.salt : 'x'.repeat(32);
  const h = await hashPw(password, salt);
  if (!user || !safeEq(h, user.pass)) return { err: 'Email ou senha incorretos' };
  user.logins = (user.logins || 0) + 1;
  user.lastLogin = Date.now();
  touch(user);
  return { token: newToken(id), user: pub(user) };
}

// login automático por token guardado no aparelho
function resume(t) {
  const s = sessions.get(t);
  if (!s || s.exp < Date.now()) { sessions.delete(t); return { err: 'sessão expirada' }; }
  const user = db.users[s.id];
  return user ? { token: t, user: pub(user) } : { err: 'sessão expirada' };
}

const byId = id => db.users[id] || null;
const userByToken = t => {
  const s = sessions.get(t);
  if (!s || s.exp < Date.now()) return null;
  return db.users[s.id] || null;
};

function setCoins(id, coins) {
  const u = db.users[id];
  if (!u) return;
  u.coins = Math.max(0, Math.round(coins));
  touch(u);
}

// resultado de partida valendo ranking (Elo K=32, começa em 1000)
function recordResult(winnerId, loserId) {
  const w = db.users[winnerId], l = db.users[loserId];
  if (!w || !l || w === l) return null;
  const expected = 1 / (1 + Math.pow(10, (l.pts - w.pts) / 400));
  const d = Math.max(4, Math.round(32 * (1 - expected)));
  w.pts += d; l.pts = Math.max(0, l.pts - d);
  w.w = (w.w || 0) + 1; l.l = (l.l || 0) + 1;
  touch(w); touch(l);
  return d;
}

function addPlayTime(id, seconds) {
  const u = db.users[id];
  if (!u) return;
  u.hours = (u.hours || 0) + seconds / 3600;
  touch(u);
}

function top(n = 20) {
  return Object.values(db.users)
    .sort((a, b) => b.pts - a.pts)
    .slice(0, n)
    .map(u => ({ nick: u.nick, pts: u.pts, w: u.w, l: u.l }));
}

// resumo para o painel do dono
function adminStats() {
  const users = Object.values(db.users);
  const now = Date.now();
  const dia = 24 * 3600 * 1000;
  return {
    total: users.length,
    ativos24h: users.filter(u => now - u.lastLogin < dia).length,
    horasTotais: Math.round(users.reduce((s, u) => s + (u.hours || 0), 0)),
    maisHoras: users.slice().sort((a, b) => (b.hours || 0) - (a.hours || 0)).slice(0, 10)
      .map(u => ({ nick: u.nick, horas: +(u.hours || 0).toFixed(1), logins: u.logins, pts: u.pts })),
    maisLogins: users.slice().sort((a, b) => (b.logins || 0) - (a.logins || 0)).slice(0, 10)
      .map(u => ({ nick: u.nick, logins: u.logins, horas: +(u.hours || 0).toFixed(1) })),
    afiliados: users.filter(u => (u.refCount || 0) > 0).sort((a, b) => b.refCount - a.refCount).slice(0, 10)
      .map(u => ({ nick: u.nick, indicados: u.refCount, ganhou: u.refEarn })),
  };
}

module.exports = {
  ready, register, login, resume, byId, userByToken, pub,
  setCoins, recordResult, addPlayTime, top, adminStats,
};
