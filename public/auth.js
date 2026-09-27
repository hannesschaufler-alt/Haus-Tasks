// Google-Anmeldung im Browser über Google Identity Services (GIS) – läuft komplett ohne eigenen Server,
// bewusst passend für eine rein statisch gehostete Seite. Anders als bei der bisherigen Desktop-App gibt
// es hier keinen dauerhaften Refresh-Token: Der Zugriffstoken lebt ca. eine Stunde und wird erneuert,
// solange die Google-Sitzung im Browser aktiv ist – meist unbemerkt im Hintergrund, ohne erneute Anmeldung.
(function (root) {
  const STORAGE_KEY = 'haus-tasks-google-token';
  let tokenClient = null;
  let current = loadStored(); // { access_token, expires_at } | null
  const listeners = new Set();

  function loadStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const t = JSON.parse(raw);
      return t && t.expires_at > Date.now() ? t : null;
    } catch {
      return null;
    }
  }

  function store(token) {
    current = token;
    try {
      if (token) localStorage.setItem(STORAGE_KEY, JSON.stringify(token));
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* z. B. privater Modus ohne Speicherzugriff: einfach nur im Speicher behalten */ }
    listeners.forEach((cb) => cb(!!token));
  }

  function loadGis() {
    if (root.google?.accounts?.oauth2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Google-Anmeldedienst konnte nicht geladen werden (keine Verbindung?)'));
      document.head.append(s);
    });
  }

  async function ensureClient() {
    await loadGis();
    if (tokenClient) return tokenClient;
    if (!root.GOOGLE_CLIENT_ID || root.GOOGLE_CLIENT_ID.includes('HIER-DEINE')) {
      throw new Error('Google-Client-ID fehlt noch (google-config.js).');
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: root.GOOGLE_CLIENT_ID,
      scope: root.GOOGLE_SCOPE,
      callback: () => {}, // wird pro Aufruf überschrieben, siehe requestToken()
    });
    return tokenClient;
  }

  function requestToken(promptMode) {
    return new Promise((resolve, reject) => {
      tokenClient.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        const token = { access_token: resp.access_token, expires_at: Date.now() + (Number(resp.expires_in) || 3000) * 1000 };
        store(token);
        resolve(token);
      };
      tokenClient.requestAccessToken({ prompt: promptMode });
    });
  }

  // Meldet an (mit Google-Auswahlbildschirm, falls nötig). Muss von einer echten Nutzer-Interaktion
  // (Klick) aus aufgerufen werden, sonst blockieren Browser das Pop-up.
  async function signIn() {
    await ensureClient();
    return requestToken('consent');
  }

  function signOut() {
    if (current?.access_token && root.google?.accounts?.oauth2) {
      google.accounts.oauth2.revoke(current.access_token, () => {});
    }
    store(null);
  }

  // Liefert einen gültigen Zugriffstoken, erneuert ihn bei Bedarf im Hintergrund. Wirft, wenn dafür eine
  // erneute, sichtbare Anmeldung nötig wäre (z. B. Zugriff wurde bei Google widerrufen) – die Oberfläche
  // zeigt dann wieder den Anmelde-Button.
  async function getToken() {
    if (current && current.expires_at > Date.now() + 30000) return current.access_token;
    await ensureClient();
    try {
      return (await requestToken('')).access_token; // '' = versucht es zunächst still, ohne Pop-up
    } catch (e) {
      store(null);
      throw Object.assign(new Error('Bei Google abgemeldet oder Zugriff entzogen – bitte neu anmelden.'), { authRequired: true });
    }
  }

  function isSignedIn() {
    return !!current;
  }

  function onChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  root.Auth = { signIn, signOut, getToken, isSignedIn, onChange };
})(window);
