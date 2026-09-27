// App-Shell-Cache: die Seite selbst soll sich möglichst auch ganz ohne Verbindung öffnen lassen.
// Die eigentlichen Daten laufen NICHT über diesen Cache, sondern direkt gegen Google (siehe offline.js,
// gcal-remote.js) mit IndexedDB als lokalem Speicher – hier geht es nur darum, dass HTML/CSS/JS/Icons
// überhaupt laden, wenn gerade keine Verbindung besteht. Hinweis: ein Service Worker registriert sich
// nur über HTTPS oder localhost, siehe README.
//
// Alle Pfade relativ zur eigenen Registrierungs-Scope aufgebaut (nicht fest „/…“), damit das auch
// funktioniert, wenn die Seite nicht auf der Domain-Wurzel liegt (z. B. GitHub Pages: .../Haus-Tasks/).
const SCOPE = self.registration.scope; // z. B. https://<konto>.github.io/Haus-Tasks/
const CACHE = 'haus-tasks-shell-v3';
const SHELL_FILES = [
  '', 'haushalt.html', 'manifest.webmanifest',
  'recurrence.js', 'offline-logic.js', 'sync-core.js', 'google-config.js', 'auth.js', 'gcal-remote.js', 'offline.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'favicon.svg', 'favicon.ico',
];
const SHELL = SHELL_FILES.map((f) => new URL(f, SCOPE).toString());
const START = new URL('.', SCOPE).toString();

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (!url.href.startsWith(SCOPE) || e.request.method !== 'GET') return; // fremde Herkunft (z. B. Google) läuft immer live

  if (e.request.mode === 'navigate') {
    // Die Seite selbst: zuerst frisch aus dem Netz, damit Updates ankommen; ohne Verbindung aus dem Cache.
    e.respondWith(
      fetch(e.request)
        .then((res) => { caches.open(CACHE).then((c) => c.put(START, res.clone())); return res; })
        .catch(() => caches.match(START))
    );
    return;
  }
  // Statische Dateien: aus dem Cache, im Hintergrund aktualisieren.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fresh = fetch(e.request).then((res) => { caches.open(CACHE).then((c) => c.put(e.request, res.clone())); return res; }).catch(() => cached);
      return cached || fresh;
    })
  );
});
