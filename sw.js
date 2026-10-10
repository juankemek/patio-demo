// Pátio · avisos no celular. O servidor só "cutuca" o aparelho; o texto do aviso é buscado aqui.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let m = null;
    try { if (e.data) m = e.data.json(); } catch (x) { /* sem conteúdo */ }
    if (!m) {
      try {
        const s = await self.registration.pushManager.getSubscription();
        const r = await fetch('/api/aviso_ultimo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_endpoint: s && s.endpoint }) });
        const j = await r.json();
        if (j && j.ok) m = j;
      } catch (x) { /* sem internet: mostra o aviso padrão */ }
    }
    m = m || { titulo: 'Pátio', corpo: 'Chegou um cliente novo pelo site da loja.', url: '/' };
    await self.registration.showNotification(m.titulo, {
      body: m.corpo, icon: '/icone-192.png', badge: '/icone-192.png', lang: 'pt-BR',
      tag: 'patio-' + Date.now(), data: { url: m.url || '/' }, vibrate: [120, 60, 120],
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const alvo = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const abertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of abertas) if (c.url.split('#')[0] === alvo && 'focus' in c) return c.focus();
    return self.clients.openWindow(alvo);
  })());
});
