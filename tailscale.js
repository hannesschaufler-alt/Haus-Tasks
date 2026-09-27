// Findet die IPv4-Adressen der Tailscale-Schnittstelle. Nur diese (und localhost) bekommen den Server,
// nicht das Heimnetz: so bleibt die App ohne Login trotzdem auf die eigenen Geräte beschränkt.
//
// Der Schnittstellenname wird mitgeprüft, weil auch Provider mit Carrier-Grade-NAT Adressen aus
// 100.64.0.0/10 vergeben, die nicht zu Tailscale gehören.
function isTailscaleRange(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

function tailscaleAddresses(interfaces) {
  const out = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!/tailscale/i.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && isTailscaleRange(a.address)) out.push(a.address);
    }
  }
  return out;
}

module.exports = { tailscaleAddresses, isTailscaleRange };
