// sw.js — cache do "app shell" (abre o menu/treino vs bot sem internet)
// + notificações com o jogo em segundo plano.
const CACHE = 'sinuca-shell-v1';
const SHELL = [
  '/', '/index.html', '/manifest.json', '/css/style.css',
  '/js/physics.js', '/js/ai.js', '/js/net.js', '/js/game.js', '/js/ui.js',
  '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// a chave do cache ignora a query string (?v=NN): o jogo já bumpa a versão
// a cada mudança de js/css pra forçar recarregar quando online — pro cache
// offline isso só atrapalharia (o pedido real vem sempre com ?v=<versão
// atual>, então uma entrada guardada com ?v=27 nunca bateria com ?v=28).
function cacheKey(req) {
  const u = new URL(req.url);
  u.search = '';
  return u.toString();
}

// rede primeiro: o próprio jogo já sabe forçar atualização (ver APP_VER no
// server.js) — o cache só entra em cena se a rede falhar (offline), pra
// abrir o menu e jogar treino vs bot mesmo sem internet.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return; // POST (/register, /wallet...) nunca passa por cache
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // fonte do Google etc: deixa passar direto
  if (url.pathname === '/admin' || url.pathname === '/reports') return; // painel do dono: nunca cacheia
  const key = cacheKey(req);
  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(key).then(cached => cached || caches.match('/index.html')))
  );
});

// tocar na notificação volta pro jogo
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      if (list.length) return list[0].focus();
      return self.clients.openWindow('/');
    })
  );
});
