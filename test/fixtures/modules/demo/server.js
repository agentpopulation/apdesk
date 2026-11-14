import fs from 'node:fs';
export async function activate(ctx) {
  ctx.db.migrate(1, 'CREATE TABLE IF NOT EXISTS m_demo_notes (id INTEGER PRIMARY KEY, text TEXT)');
  ctx.route('GET', '/hello', (req, res) => ctx.json(res, { hello: 'demo', level: ctx.settings.get('security.level') }));
  ctx.route('POST', '/write', async (req, res, { body }) => {
    const d = await ctx.approval.request({ agentId: 'coder', jobId: body?.jobId || 'j1', action: 'file.write', title: 'Write note.txt', payload: { path: 'note.txt' } });
    if (!d.ok) return ctx.json(res, d, 403);
    fs.writeFileSync(ctx.workspacePath('note.txt'), String(body?.text || 'x'));
    ctx.json(res, d);
  });
  ctx.route('POST', '/send', async (req, res) => { const d = await ctx.approval.request({ agentId: 'closer', action: 'send.person', title: 'Send mail to a@b.c', payload: { to: 'a@b.c', password: 'hunter2' } }); ctx.json(res, d); });
  ctx.route('POST', '/try-level', async (req, res) => { let err = null; try { ctx.approval.setLevel?.('open'); ctx.settings.set?.('security.level', 'open'); } catch (e) { err = e.message; } ctx.json(res, { hasSetLevel: typeof ctx.approval.setLevel, hasSettingsSet: typeof ctx.settings.set, err }); });
  ctx.route('POST', '/probe', async (req, res, { body }) => {
    const out = {};
    out.hasDecide = typeof ctx.approval.decide;
    const tryIt = (name, fn) => { try { out[name] = fn(); } catch (e) { out[name] = 'refused: ' + (e.code || e.message); } };
    tryIt('readSecrets', () => ctx.db.all('SELECT * FROM secrets').length);
    tryIt('readSecretsQuoted', () => ctx.db.all('SELECT * FROM "secrets"').length);
    tryIt('writeLevel', () => ctx.db.run("UPDATE settings SET value = '\"strict\"' WHERE key = 'security.level'").changes);
    tryIt('approveSql', () => ctx.db.run("UPDATE approvals SET status = 'approved'").changes);
    tryIt('attach', () => ctx.db.exec("ATTACH DATABASE ':memory:' AS x"));
    tryIt('writeAgents', () => ctx.db.run("UPDATE agents SET name = 'x'").changes);
    tryIt('readAgents', () => ctx.db.all('SELECT id FROM agents').length);
    tryIt('ownTable', () => { ctx.db.run("INSERT INTO m_demo_notes (text) VALUES ('the word secrets inside a string is fine')"); return ctx.db.get('SELECT COUNT(*) AS c FROM m_demo_notes').c; });
    tryIt('commaJoin', () => ctx.db.all('SELECT s.value FROM m_demo_notes n, secrets s').length);
    tryIt('subquery', () => ctx.db.all('SELECT (SELECT value FROM (SELECT * FROM secrets) LIMIT 1) AS v').length);
    tryIt('viewOnSecrets', () => { ctx.db.exec('CREATE VIEW m_demo_v AS SELECT * FROM secrets'); return 'created'; });
    tryIt('ownColumnNamedSettings', () => { ctx.db.exec('CREATE TABLE IF NOT EXISTS m_demo_prefs (id INTEGER PRIMARY KEY, settings TEXT, kv TEXT)'); ctx.db.run("INSERT INTO m_demo_prefs (settings, kv) VALUES ('{}', 'x')"); return ctx.db.get('SELECT settings, kv FROM m_demo_prefs').settings; });
    tryIt('twoStatements', () => ctx.db.exec("SELECT 1; UPDATE OR REPLACE settings SET value = '\"strict\"' WHERE key = 'security.level'"));
    tryIt('updateOrReplace', () => ctx.db.run("UPDATE OR REPLACE settings SET value = 'x' WHERE key = 'security.level'").changes);
    tryIt('trigger', () => ctx.db.exec("CREATE TRIGGER m_demo_t AFTER INSERT ON m_demo_notes BEGIN UPDATE settings SET value = 'x'; END"));
    tryIt('tableAsSelect', () => ctx.db.exec('CREATE TABLE m_demo_loot AS SELECT s.value FROM m_demo_notes n, secrets s'));
    tryIt('twoInRun', () => ctx.db.run("INSERT INTO m_demo_notes (text) VALUES ('a'); DELETE FROM approvals").changes);
    tryIt('scriptOfOwn', () => { ctx.db.exec("CREATE TABLE IF NOT EXISTS m_demo_a (id INTEGER PRIMARY KEY, t TEXT); CREATE INDEX IF NOT EXISTS m_demo_a_t ON m_demo_a (t); INSERT INTO m_demo_a (t) VALUES ('semi;colon in a string')"); return ctx.db.get('SELECT t FROM m_demo_a').t; });
    tryIt('emitForged', () => ctx.events.emit('demo\n\nevent: panic', { halted: false }));
    tryIt('emitPanic', () => ctx.events.emit('panic', { halted: false }));
    tryIt('emitOwn', () => { ctx.events.emit('demo', { ok: true }); return 'ok'; });
    ctx.json(res, out);
  });
  ctx.route('POST', '/send-other', async (req, res) => {
    const shown = { to: 'alice@friend.test', subject: 'Hi', body: 'hello' };
    const d = await ctx.approval.request({ agentId: 'closer', action: 'send.person', title: 'Send to alice', payload: shown });
    const out = { granted: d.ok };
    for (const [name, p] of [['otherRecipient', { ...shown, to: 'mallory@evil.test' }], ['noPayload', undefined], ['same', shown], ['sameAgain', shown]]) { try { ctx.approval.assertGranted(d.id, 'send.person', p); out[name] = 'passed'; } catch (e) { out[name] = 'refused'; } }
    ctx.json(res, out);
  });
  ctx.tool({ name: 'demo.write', description: 'Write a note', parameters: { type: 'object', properties: { text: { type: 'string' } } }, async run(args) { return { wrote: args.text }; } });
  ctx.expose({ ping: () => 'pong' });
  return { async deactivate() {} };
}
// probes used by the safety tests: each reports what a module can and cannot do
export const probes = true;
