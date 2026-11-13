/*
 * Web Push handlers for the beamhop service worker (§9). Imported into the Workbox-generated
 * worker through `workbox.importScripts` (vite.config.ts), so the precache setup stays generated.
 *
 * Payload (from the daemon, never secrets): { title, body, url, category, approvalId?, tag? }.
 */
/* global self, clients */

const sameOrigin = (url) => {
  try {
    const u = new URL(url, self.registration.scope);
    return u.origin === self.location.origin ? u.href : new URL('./', self.registration.scope).href;
  } catch {
    return new URL('./', self.registration.scope).href;
  }
};

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'beamhop';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    icon: 'icons/icon-192.png',
    badge: 'icons/monochrome-512.png',
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    renotify: typeof data.tag === 'string',
    requireInteraction: data.category === 'approvals' || data.category === 'security',
    data: {
      url: sameOrigin(typeof data.url === 'string' ? data.url.replace(/^\//, './') : './'),
      approvalId: typeof data.approvalId === 'string' ? data.approvalId : undefined,
      category: data.category,
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || new URL('./', self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) {
        if (new URL(w.url).origin !== self.location.origin) continue;
        await w.focus();
        if ('navigate' in w) await w.navigate(url).catch(() => undefined);
        return;
      }
      await clients.openWindow(url);
    })(),
  );
});
