// Implementiert die von sync-core.js erwartete `remote`-Schnittstelle direkt gegen die Google-Calendar-
// REST-API (kein eigener Server dazwischen). Portabel: braucht nur `fetch` (Browser oder Node ≥ 18) und
// bekommt Zugriffstoken sowie Kalender-ID von außen übergeben.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.GcalRemote = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const API = 'https://www.googleapis.com/calendar/v3';
  const CONFIG_MARKER = 'haus-tasks-config';

  function apiError(status, data) {
    const e = new Error(data?.error?.message || `Google-Kalender-Fehler ${status}`);
    e.status = status;
    return e;
  }

  // `getToken` wird bei jedem Aufruf neu abgefragt (nicht einmalig übergeben), damit ein zwischendurch
  // erneuerter Token automatisch verwendet wird, ohne den Remote neu erzeugen zu müssen.
  function makeGcalRemote(getToken, getCalendarId) {
    async function call(path, opts = {}) {
      const token = await getToken();
      const calendarId = await getCalendarId();
      if (!calendarId) throw new Error('Noch kein geteilter Kalender eingerichtet.');
      const url = `${API}/calendars/${encodeURIComponent(calendarId)}${path}`;
      const res = await fetch(url, {
        ...opts,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
      });
      if (res.status === 204) return null;
      const data = await res.json().catch(() => null);
      if (!res.ok) throw apiError(res.status, data);
      return data;
    }

    return {
      async listChanges(syncToken) {
        const events = [];
        let pageToken;
        let nextSyncToken;
        do {
          const qs = new URLSearchParams({ maxResults: '250', ...(pageToken ? { pageToken } : {}), ...(syncToken ? { syncToken } : {}) });
          const data = await call(`/events?${qs}`);
          events.push(...(data.items || []));
          pageToken = data.nextPageToken;
          nextSyncToken = data.nextSyncToken || nextSyncToken;
        } while (pageToken);
        return { events, nextSyncToken, incremental: !!syncToken };
      },
      get: (id) => call(`/events/${encodeURIComponent(id)}`),
      insert: (body) => call('/events', { method: 'POST', body: JSON.stringify(body) }),
      patch: (id, body) => call(`/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
      remove: (id) => call(`/events/${encodeURIComponent(id)}`, { method: 'DELETE' }),

      // Kategorien/Orte liegen als versteckter, ganztägiger Termin auf dem 1.1.1970 (fällt in der Praxis
      // niemandem auf); privateExtendedProperty filtert serverseitig, ohne den ganzen Kalender laden zu müssen.
      async readConfig() {
        const qs = new URLSearchParams({ privateExtendedProperty: `appMarker=${CONFIG_MARKER}`, maxResults: '1', showDeleted: 'false' });
        const data = await call(`/events?${qs}`);
        const ev = data.items?.[0];
        if (!ev) return null;
        const p = ev.extendedProperties?.private || {};
        try {
          return { id: ev.id, updated: ev.updated, categories: JSON.parse(p.categories || '{}'), locations: JSON.parse(p.locations || '[]') };
        } catch {
          return { id: ev.id, updated: ev.updated, categories: {}, locations: [] };
        }
      },
      async writeConfig(id, cfg) {
        const body = {
          summary: '⚙️ Haus-Tasks Einstellungen (bitte nicht löschen oder bearbeiten)',
          start: { date: '1970-01-01' }, end: { date: '1970-01-02' },
          visibility: 'private', transparency: 'transparent',
          extendedProperties: { private: { appMarker: CONFIG_MARKER, categories: JSON.stringify(cfg.categories), locations: JSON.stringify(cfg.locations) } },
        };
        const ev = id ? await call(`/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) })
          : await call('/events', { method: 'POST', body: JSON.stringify(body) });
        return { id: ev.id, updated: ev.updated };
      },
    };
  }

  return { makeGcalRemote, CONFIG_MARKER };
});
