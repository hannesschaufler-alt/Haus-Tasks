const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const QRCode = require('qrcode');
const { tailscaleAddresses } = require('./tailscale');
const { networkInfo } = require('./network');
const { PORT, PRIORITIES, COLORS } = require('./config');
const { getMeta } = require('./db');
const tasks = require('./tasks');
const categories = require('./categories');
const locations = require('./locations');
const { ValidationError } = require('./errors');
const { runSync } = require('./sync');
const { isConnected } = require('./gcal');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Sync: nie parallel im selben Prozess, Änderungen werden kurz gesammelt ---
let running = null;
let queued = false;
let timer = null;

function syncNow() {
  if (!isConnected()) return Promise.resolve({ connected: false });
  if (running) {
    queued = true;
    return running;
  }
  running = runSync()
    .catch((e) => ({ error: e.message }))
    .finally(() => {
      running = null;
      if (queued) { queued = false; syncNow(); }
    });
  return running;
}

function scheduleSync() {
  clearTimeout(timer);
  timer = setTimeout(syncNow, 800);
}

// --- API ---
const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Interner Fehler' });
  }
};

app.get('/api/config', (req, res) => {
  res.json({ categories: categories.list(), locations: locations.list(), priorities: PRIORITIES, colors: COLORS });
});

app.post('/api/locations', wrap((req, res) => res.status(201).json(locations.create(req.body))));

app.patch('/api/locations/:name', wrap((req, res) => {
  const list = locations.update(req.params.name, req.body);
  if (!list) return res.status(404).json({ error: 'Ort nicht gefunden' });
  res.json(list);
}));

app.delete('/api/locations/:name', wrap((req, res) => {
  const list = locations.remove(req.params.name);
  if (!list) return res.status(404).json({ error: 'Ort nicht gefunden' });
  res.json(list);
}));

// Antworten liefern die aktuelle Kategorienliste, umbenannte Tasks holt die Oberfläche neu.
app.post('/api/categories', wrap((req, res) => res.status(201).json(categories.create(req.body))));

app.patch('/api/categories/:name', wrap((req, res) => {
  const list = categories.update(req.params.name, req.body);
  if (!list) return res.status(404).json({ error: 'Kategorie nicht gefunden' });
  res.json(list);
}));

app.delete('/api/categories/:name', wrap((req, res) => {
  const list = categories.remove(req.params.name);
  if (!list) return res.status(404).json({ error: 'Kategorie nicht gefunden' });
  res.json(list);
}));

app.get('/api/tasks', wrap((req, res) => res.json(tasks.listTasks())));

app.post('/api/tasks', wrap((req, res) => {
  const t = tasks.createTask(req.body);
  scheduleSync();
  res.status(201).json(t);
}));

app.patch('/api/tasks/:id', wrap((req, res) => {
  const t = tasks.updateTask(Number(req.params.id), req.body);
  if (!t) return res.status(404).json({ error: 'Task nicht gefunden' });
  scheduleSync();
  res.json(t);
}));

app.post('/api/tasks/:id/done', wrap((req, res) => {
  const t = tasks.setDone(Number(req.params.id), !!req.body.done);
  if (!t) return res.status(404).json({ error: 'Task nicht gefunden' });
  scheduleSync();
  res.json(t);
}));

app.delete('/api/tasks/:id', wrap((req, res) => {
  if (!tasks.deleteTask(Number(req.params.id))) return res.status(404).json({ error: 'Task nicht gefunden' });
  scheduleSync();
  res.status(204).end();
}));

app.get('/api/status', (req, res) => {
  res.json({
    connected: isConnected(),
    syncing: !!running,
    last_sync: getMeta('last_sync'),
    last_error: getMeta('last_error'),
  });
});

app.post('/api/sync', async (req, res) => {
  const result = await syncNow();
  res.json({ ...result, tasks: tasks.listTasks() });
});

// Grundlage für die Einladungsseite (public/haushalt.html): unter welcher Adresse dieser PC im Tailnet hängt.
app.get('/api/invite', (req, res) => res.json(networkInfo()));

app.get('/api/invite-qr.svg', async (req, res, next) => {
  const info = networkInfo();
  if (!info.url) return res.status(404).json({ error: 'Kein Tailscale erkannt' });
  try {
    res.type('svg').send(await QRCode.toString(info.url, { type: 'svg', margin: 1 }));
  } catch (e) {
    next(e);
  }
});

// --- Erreichbarkeit: localhost immer, zusätzlich die Tailscale-Adresse (Handy im eigenen Tailnet) ---
// Bewusst nicht 0.0.0.0: Die App hat keinen Login, daher kein Zugriff aus dem Heimnetz.
const bound = new Map();

function listenOn(host, onFatal) {
  const server = http.createServer(app);
  server.on('error', (e) => {
    console.error(`Kann ${host}:${PORT} nicht belegen: ${e.message}`);
    bound.delete(host);
    if (onFatal) process.exit(1); // z. B. läuft schon eine Instanz
  });
  server.listen(PORT, host, () => {
    console.log(host === '127.0.0.1'
      ? `Haus-Tasks läuft auf http://localhost:${PORT}`
      : `Im Tailnet erreichbar unter http://${host}:${PORT} bzw. http://${os.hostname().toLowerCase()}:${PORT}`);
  });
  bound.set(host, server);
}

// Tailscale kann beim Systemstart später als der Server bereit sein, deshalb regelmäßig nachsehen.
function bindTailscale() {
  for (const ip of tailscaleAddresses(os.networkInterfaces())) if (!bound.has(ip)) listenOn(ip, false);
}

listenOn('127.0.0.1', true);
bindTailscale();
setInterval(bindTailscale, 30 * 1000);

syncNow(); // Sync beim Start
// Läuft der Server dauerhaft, hält er den Kalender auch ohne offene Seite aktuell.
setInterval(syncNow, 15 * 60 * 1000);
