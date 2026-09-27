const test = require('node:test');
const assert = require('node:assert');
const { tailscaleAddresses, isTailscaleRange } = require('../tailscale');

const v4 = (address, internal = false) => ({ address, family: 'IPv4', internal });

test('Tailscale-Adresse wird über Name und Bereich erkannt', () => {
  const ifaces = {
    'Ethernet': [v4('192.168.1.20')],
    'Tailscale': [{ address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false }, v4('100.101.102.103')],
    'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
  };
  assert.deepStrictEqual(tailscaleAddresses(ifaces), ['100.101.102.103']);
});

test('Carrier-Grade-NAT-Adresse auf einer anderen Schnittstelle wird ignoriert', () => {
  assert.deepStrictEqual(tailscaleAddresses({ 'Ethernet': [v4('100.72.0.5')] }), []);
});

test('Adresse im Tailscale-Namen, aber außerhalb 100.64.0.0/10, wird ignoriert', () => {
  assert.deepStrictEqual(tailscaleAddresses({ 'Tailscale': [v4('192.168.5.5')] }), []);
});

test('Bereichsgrenzen', () => {
  assert.strictEqual(isTailscaleRange('100.64.0.1'), true);
  assert.strictEqual(isTailscaleRange('100.127.255.254'), true);
  assert.strictEqual(isTailscaleRange('100.63.0.1'), false);
  assert.strictEqual(isTailscaleRange('100.128.0.1'), false);
});
