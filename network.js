// Liefert, unter welcher Adresse dieser PC im eigenen Tailnet erreichbar ist – Grundlage für die
// Einladungsseite (public/haushalt.html), die anderen Haushaltsmitgliedern den Zugriff erklärt.
const os = require('node:os');
const { tailscaleAddresses } = require('./tailscale');
const { PORT } = require('./config');

function networkInfo() {
  const addresses = tailscaleAddresses(os.networkInterfaces());
  const hostname = os.hostname().toLowerCase();
  return {
    connected: addresses.length > 0,
    url: addresses[0] ? `http://${addresses[0]}:${PORT}` : null,
    hostnameUrl: `http://${hostname}:${PORT}`,
    addresses,
    hostname,
    port: PORT,
  };
}

module.exports = { networkInfo };
