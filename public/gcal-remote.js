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
    e.reason = data?.error?.errors?.[0]?.reason; // z. B. „quotaExceeded“ (Calendar usage limits exceeded) oder „rateLimitExceeded“
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

    // Zeitzone des Kalenders (nicht des Geräts) - gebraucht für die Plätze am Tagesende, siehe sync-core.js.
    // Einmal pro Kalender nachfragen, ein Fehler (z. B. offline) ist kein Problem: dann gilt die Zeitzone des Geräts.
    let timeZone = null;
    let timeZoneFor = null;

    return {
      async getTimeZone() {
        const calendarId = await getCalendarId();
        if (timeZone && timeZoneFor === calendarId) return timeZone;
        const cal = await call('');
        if (cal?.timeZone) { timeZone = cal.timeZone; timeZoneFor = calendarId; }
        return timeZone;
      },
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
      // Alle Konfigurations-Termine (normal genau einer; zwei Geräte, die gleichzeitig zum ersten Mal synchronisieren, können
      // aber je einen anlegen). Ein nicht lesbarer Termin wird als `invalid` markiert statt stillschweigend als „leere
      // Einstellungen“ zu gelten – sonst würden die Listen auf dem Gerät durch eine leere Konfiguration ersetzt.
      async readConfigs() {
        const qs = new URLSearchParams({ privateExtendedProperty: `appMarker=${CONFIG_MARKER}`, maxResults: '20', showDeleted: 'false' });
        const data = await call(`/events?${qs}`);
        return (data.items || []).map((ev) => {
          const p = ev.extendedProperties?.private || {};
          try {
            return { id: ev.id, updated: ev.updated, categories: JSON.parse(p.categories || '{}'), locations: JSON.parse(p.locations || '[]'), settings: JSON.parse(p.settings || '{}') };
          } catch {
            return { id: ev.id, updated: ev.updated, invalid: true, categories: {}, locations: [], settings: {} };
          }
        });
      },
      // Maßgeblich ist der zuletzt geschriebene lesbare Termin (bei mehreren: der neueste, nicht ein beliebiger).
      async readConfig() {
        const all = await this.readConfigs();
        if (!all.length) return null;
        const byNewest = (a, b) => String(b.updated || '').localeCompare(String(a.updated || ''));
        return [...all].filter((c) => !c.invalid).sort(byNewest)[0] || [...all].sort(byNewest)[0];
      },
      async writeConfig(id, cfg) {
        const body = {
          summary: '⚙️ Haus-Tasks Einstellungen (bitte nicht löschen oder bearbeiten)',
          start: { date: '1970-01-01' }, end: { date: '1970-01-02' },
          visibility: 'private', transparency: 'transparent',
          extendedProperties: { private: { appMarker: CONFIG_MARKER, categories: JSON.stringify(cfg.categories), locations: JSON.stringify(cfg.locations), settings: JSON.stringify(cfg.settings || {}) } },
        };
        const ev = id ? await call(`/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) })
          : await call('/events', { method: 'POST', body: JSON.stringify(body) });
        return { id: ev.id, updated: ev.updated };
      },
    };
  }

  return { makeGcalRemote, CONFIG_MARKER };
});
