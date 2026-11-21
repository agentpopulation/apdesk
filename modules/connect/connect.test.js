// Plumbing tests for Connect (MCP): no server process is ever started here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { installSource } from './server.js';

test('install source: each package runner names its registry and the package', () => {
  assert.deepEqual(installSource('npx', ['-y', '@modelcontextprotocol/server-filesystem', '{workspace}']), { from: 'registry.npmjs.org', pkg: '@modelcontextprotocol/server-filesystem' });
  assert.deepEqual(installSource('npx.cmd', ['-y', 'some-server']), { from: 'registry.npmjs.org', pkg: 'some-server' });
  assert.deepEqual(installSource('bunx', ['tool-x']), { from: 'registry.npmjs.org', pkg: 'tool-x' });
  assert.deepEqual(installSource('pnpm', ['dlx', 'tool-y']), { from: 'registry.npmjs.org', pkg: 'tool-y' });
  assert.deepEqual(installSource('yarn', ['dlx', 'tool-z']), { from: 'registry.npmjs.org', pkg: 'tool-z' });
  assert.deepEqual(installSource('uvx', ['mcp-server-fetch']), { from: 'pypi.org', pkg: 'mcp-server-fetch' });
  assert.deepEqual(installSource('pipx', ['run', 'mcp-server-time']), { from: 'pypi.org', pkg: 'mcp-server-time' });
  assert.deepEqual(installSource('docker', ['run', '-i', '--rm', '-e', 'A=b', 'mcp/fetch']), { from: 'Docker Hub', pkg: 'mcp/fetch' });
  assert.equal(installSource('node', ['server.js']), null);
});

test('install source: a spec that names another place is labelled with that place, not the runner\'s registry', () => {
  assert.deepEqual(installSource('uvx', ['--from', 'git+https://github.com/oraios/serena', 'serena']), { from: 'github.com', pkg: 'serena' });
  assert.deepEqual(installSource('pipx', ['run', '--spec', 'git+ssh://git@gitlab.com/a/b.git', 'b']), { from: 'gitlab.com', pkg: 'b' });
  assert.deepEqual(installSource('uvx', ['--from', 'mcp-thing==1.2', 'mcp-thing']), { from: 'pypi.org', pkg: 'mcp-thing' });
  assert.deepEqual(installSource('npx', ['-y', 'github:user/repo']), { from: 'github.com', pkg: 'github:user/repo' });
  assert.deepEqual(installSource('npx', ['user/repo']), { from: 'github.com', pkg: 'user/repo' });
  assert.deepEqual(installSource('npx', ['https://evil.example/pkg.tgz']), { from: 'evil.example', pkg: 'https://evil.example/pkg.tgz' });
  assert.deepEqual(installSource('npx', ['-y', '@scope/pkg@1.0.0']), { from: 'registry.npmjs.org', pkg: '@scope/pkg@1.0.0' });
  assert.deepEqual(installSource('npx', ['-y', '--package', 'git+https://codeberg.org/x/y.git', 'y']), { from: 'codeberg.org', pkg: 'y' });
  assert.deepEqual(installSource('docker', ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server']), { from: 'ghcr.io', pkg: 'ghcr.io/github/github-mcp-server' });
  assert.deepEqual(installSource('docker', ['run', 'localhost:5000/tool']), { from: 'localhost:5000', pkg: 'localhost:5000/tool' });
  assert.deepEqual(installSource('docker', ['run', 'mcp/fetch:latest']), { from: 'Docker Hub', pkg: 'mcp/fetch:latest' });
  assert.deepEqual(installSource('npx', ['./local-pkg']), { from: 'a folder on this PC', pkg: './local-pkg' });
});

test('the start card for a package runner says where it comes from and names the package', async () => {
  const t = await testDesk({ modules: ['connect'] });
  try {
    await t.call('/api/modules/connect/on', { method: 'POST' });
    const s = await t.call('/api/m/connect/servers', { body: { name: 'Files', command: 'npx -y @modelcontextprotocol/server-filesystem {workspace}' } });
    assert.equal(s.status, 200, s.text);
    await t.call(`/api/m/connect/servers/${s.json.id}/start`, { body: {} });
    let card;
    for (let i = 0; i < 100 && !card; i++) { card = t.core.approval.listPending().find(a => a.action === 'install'); if (!card) await new Promise(r => setTimeout(r, 30)); }
    assert.ok(card, 'the owner is asked');
    assert.match(card.detail, /From registry\.npmjs\.org\./);
    assert.match(card.detail, /@modelcontextprotocol\/server-filesystem/);
    assert.doesNotMatch(card.detail, /was not stated/);
    t.core.approval.decide(card.id, 'deny');
  } finally { await t.close(); }
});
