// Passes only when the test runs with a bare environment and cannot start a program or open a socket.
import test from 'node:test';
import assert from 'node:assert/strict';
test('the test run is locked down', () => {
  assert.deepEqual(Object.keys(process.env).filter((k) => !['TEMP', 'TMP', 'TMPDIR', 'SystemRoot'].includes(k)), []);
  assert.throws(() => process.getBuiltinModule('child_process').execSync('echo x'), /ERR_ACCESS_DENIED|restricted/);
  assert.throws(() => process.getBuiltinModule('dgram').createSocket('udp4'), /No network during the check/);
  assert.throws(() => fetch('http://127.0.0.1:9'), /No network during the check/);
});
