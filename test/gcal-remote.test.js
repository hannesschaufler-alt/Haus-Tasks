const test = require('node:test');
const assert = require('node:assert');
const { makeGcalRemote } = require('../public/gcal-remote');

// Ersetzt den globalen fetch durch eine Attrappe, die Aufrufe protokolliert und aus einer Liste
// vorbereiteter Antworten bedient – so bleibt der Test unabhängig von einer echten Google-Verbindung.
function fakeFetch(responses) {
  const calls = [];
  let i = 0;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const r = responses[Math.min(i++, responses.length - 1)];
    return { status: r.status ?? 200, ok: (r.status ?? 200) < 300, json: async () => r.body };
  };
  return calls;
}

const remote = (calls, calendarId = 'haus@group.calendar.google.com') =>
  makeGcalRemote(async () => 'tok123', async () => calendarId);

test.afterEach(() => { delete global.fetch; });

test('Jeder Aufruf trägt den Zugriffstoken und die (kodierte) Kalender-ID in der URL', async () => {
  const calls = fakeFetch([{ body: { id: 'ev1', updated: 't1' } }]);
  await remote(calls, 'a b@group.calendar.google.com').get('xyz');
  assert.match(calls[0].url, /\/calendars\/a%20b%40group\.calendar\.google\.com\/events\/xyz$/);
  assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer tok123');
});

test('listChanges: einzelne Seite, syncToken wird weitergereicht', async () => {
  const calls = fakeFetch([{ body: { items: [{ id: 'e1' }], nextSyncToken: 'st1' } }]);
  const r = await remote(calls).listChanges('altertoken');
  assert.deepStrictEqual(r, { events: [{ id: 'e1' }], nextSyncToken: 'st1', incremental: true });
  assert.match(calls[0].url, /syncToken=altertoken/);
});

test('listChanges: mehrere Seiten werden zusammengeführt', async () => {
  const calls = fakeFetch([
    { body: { items: [{ id: 'e1' }], nextPageToken: 'p2' } },
    { body: { items: [{ id: 'e2' }], nextSyncToken: 'stFinal' } },
  ]);
  const r = await remote(calls).listChanges(null);
  assert.deepStrictEqual(r.events.map((e) => e.id), ['e1', 'e2']);
  assert.strictEqual(r.nextSyncToken, 'stFinal');
  assert.strictEqual(r.incremental, false);
  assert.match(calls[1].url, /pageToken=p2/);
});

test('insert/patch/remove: richtige Methode, Pfad und Body', async () => {
  const calls = fakeFetch([{ body: { id: 'e1', updated: 't' } }, { body: { id: 'e1', updated: 't2' } }, { status: 204, body: null }]);
  const r = remote(calls);
  await r.insert({ summary: 'X' });
  assert.strictEqual(calls[0].opts.method, 'POST');
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { summary: 'X' });

  await r.patch('e1', { summary: 'Y' });
  assert.strictEqual(calls[1].opts.method, 'PATCH');
  assert.match(calls[1].url, /\/events\/e1$/);

  await r.remove('e1');
  assert.strictEqual(calls[2].opts.method, 'DELETE');
});

test('Fehlerhafte Antworten werfen mit .status (für 404/410-Behandlung in sync-core.js)', async () => {
  fakeFetch([{ status: 404, body: { error: { message: 'Not Found' } } }]);
  await assert.rejects(remote([]).get('weg'), (e) => e.status === 404 && /Not Found/.test(e.message));
});

test('readConfig: filtert per privateExtendedProperty, liefert null ohne Treffer', async () => {
  const calls = fakeFetch([{ body: { items: [] } }]);
  assert.strictEqual(await remote(calls).readConfig(), null);
  assert.match(calls[0].url, /privateExtendedProperty=appMarker%3Dhaus-tasks-config/);
});

test('readConfig: liest Kategorien/Orte aus dem versteckten Termin', async () => {
  const calls = fakeFetch([{
    body: { items: [{ id: 'cfg1', updated: 't1', extendedProperties: { private: { categories: '{"Garten":"10"}', locations: '["Keller"]' } } }] },
  }]);
  const cfg = await remote(calls).readConfig();
  assert.deepStrictEqual(cfg, { id: 'cfg1', updated: 't1', categories: { Garten: '10' }, locations: ['Keller'] });
});

test('writeConfig: legt neu an ohne ID, aktualisiert mit ID', async () => {
  const calls = fakeFetch([{ body: { id: 'cfg1', updated: 't1' } }, { body: { id: 'cfg1', updated: 't2' } }]);
  const r = remote(calls);
  const created = await r.writeConfig(null, { categories: {}, locations: [] });
  assert.strictEqual(calls[0].opts.method, 'POST');
  assert.deepStrictEqual(created, { id: 'cfg1', updated: 't1' });

  await r.writeConfig('cfg1', { categories: { A: '1' }, locations: ['X'] });
  assert.strictEqual(calls[1].opts.method, 'PATCH');
  const body = JSON.parse(calls[1].opts.body);
  assert.strictEqual(body.extendedProperties.private.appMarker, 'haus-tasks-config');
  assert.strictEqual(JSON.parse(body.extendedProperties.private.categories).A, '1');
});

test('Ohne eingerichtete Kalender-ID wird ein klarer Fehler geworfen, kein Netzwerkaufruf', async () => {
  const calls = fakeFetch([]);
  const r = makeGcalRemote(async () => 'tok', async () => null);
  await assert.rejects(r.get('x'), /Kalender/);
  assert.strictEqual(calls.length, 0);
});
