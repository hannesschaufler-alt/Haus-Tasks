// Einmaliger Google-Login: npm run auth
// Startet einen lokalen Empfänger, öffnet den Browser und speichert den Token in token.json.
const http = require('node:http');
const fs = require('node:fs');
const { exec } = require('node:child_process');
const { newClient, SCOPES } = require('./gcal');
const { TOKEN_FILE } = require('./config');

const server = http.createServer();

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const redirectUri = `http://127.0.0.1:${port}`;
  const client = newClient(redirectUri);
  const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

  console.log('Öffne den Browser zur Google-Anmeldung. Falls er sich nicht öffnet, diese URL aufrufen:\n');
  console.log(url + '\n');
  exec(`start "" "${url}"`);

  server.on('request', async (req, res) => {
    const params = new URL(req.url, redirectUri).searchParams;
    const code = params.get('code');
    if (!code) {
      res.end('Kein Code erhalten.');
      return;
    }
    try {
      const { tokens } = await client.getToken(code);
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<h2>Fertig, du kannst dieses Fenster schließen.</h2>');
      console.log('Angemeldet. token.json wurde gespeichert.');
    } catch (e) {
      res.statusCode = 500;
      res.end('Anmeldung fehlgeschlagen: ' + e.message);
      console.error(e.message);
    } finally {
      server.close();
    }
  });
});
