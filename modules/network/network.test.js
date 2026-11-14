// Plumbing tests for the LAN helpers (no network needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { parseProcNetArp, parseArpDashA, subnetTargets, tcpOpen, pool, isPrivate } from './lan.js';

test('ARP parsers read Linux and Windows tables', () => {
  assert.deepEqual(parseProcNetArp('IP address HW type Flags HW address Mask Device\n192.168.1.1 0x1 0x2 aa:bb:cc:dd:ee:ff * eth0\n').map(d => d.ip), ['192.168.1.1']);
  assert.equal(parseArpDashA('Interface: 192.168.1.5 --- 0x7\n  Internet Address      Physical Address      Type\n  192.168.1.20          aa-bb-cc-dd-ee-01     dynamic\n')[0].mac, 'aa:bb:cc:dd:ee:01');
});
test('only this PC’s private /24 is a target', () => {
  const t = subnetTargets([{ family: 'IPv4', address: '192.168.1.5', private: true }, { family: 'IPv4', address: '8.8.4.4', private: false }]);
  assert.deepEqual(t.nets, ['192.168.1.0/24']); assert.equal(t.hosts.length, 254); assert.ok(t.hosts.every(isPrivate));
});
test('tcpOpen finds a listening port and not a closed one', async () => {
  const srv = net.createServer().listen(0, '127.0.0.1'); await new Promise(r => srv.once('listening', r));
  const port = srv.address().port;
  const r = await pool([port, 1], 2, (p) => tcpOpen('127.0.0.1', p, { timeoutMs: 500 }));
  assert.deepEqual(r, [true, false]); srv.close();
});
