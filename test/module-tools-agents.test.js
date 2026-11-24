// A tool registered with an agents list is offered only to those agents, and only they may run it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { testDesk } from './helpers/desk.js';

test('a tool for some agents is listed with them, and refused to any other agent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-tools-'));
  fs.mkdirSync(path.join(dir, 'helper'));
  fs.writeFileSync(path.join(dir, 'helper', 'module.json'), JSON.stringify({ id: 'helper', number: 950, name: 'Helper', description: 'A test module with a tool for one agent.', kind: 'switch-on', status: 'works', tools: ['closer_only', 'for_all'], commands: [{ name: 'helper', hint: 'Hand this to the helper' }] }));
  fs.writeFileSync(path.join(dir, 'helper', 'server.js'), `export async function activate(ctx) {
    ctx.tool({ name: 'closer_only', description: 'x', agents: ['closer'], run: async () => ({ ran: true }) });
    ctx.tool({ name: 'for_all', description: 'y', run: async () => ({ ran: true }) });
    ctx.expose({ tools: () => ctx.modules.tools() });
    return { deactivate() {} };
  }`);
  fs.writeFileSync(path.join(dir, 'shipped.json'), JSON.stringify({ entries: ['helper'] }));
  const t = await testDesk({ modulesDir: dir });
  try {
    await t.core.modules.set('helper', true);
    const m = t.core.modules.list().find(x => x.id === 'helper');
    assert.deepEqual(m.commands, [{ name: 'helper', hint: 'Hand this to the helper' }], 'the commands a module declares are in the list');
    assert.equal(m.custom, false);
    const listed = t.core.modules.api('helper').tools();
    assert.deepEqual(listed.find(x => x.name === 'closer_only').agents, ['closer']);
    assert.equal(listed.find(x => x.name === 'for_all').agents, null);
    assert.deepEqual(await t.core.modules.runTool('closer_only', {}, { agentId: 'closer' }), { ran: true });
    await assert.rejects(t.core.modules.runTool('closer_only', {}, { agentId: 'scout' }), (e) => e.code === 'not_for_agent' && !/closer_only/.test(e.message));
    assert.deepEqual(await t.core.modules.runTool('for_all', {}, { agentId: 'scout' }), { ran: true });
    assert.deepEqual(await t.core.modules.runTool('closer_only', {}, {}), { ran: true }, 'the owner\'s own run (no agent) is not refused');
  } finally { await t.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
