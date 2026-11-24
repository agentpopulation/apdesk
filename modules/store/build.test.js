// Build your own module: the form, the starter, what a model sends back, and Add a skill from a file (through the
// Agents module's own route for an owner's skill).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readForm, makeStarter, toolName } from './starter.js';
import { buildPrompt, readAnswer, changes, costWords } from './writer.js';
import { testDesk } from '../../test/helpers/desk.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = path.join(HERE, '..', '..', 'app', 'core', 'module-check', 'fixtures', 'bad', 'skills');

test('the form: plain problems for what is missing; addresses become hosts; text from the form never becomes code', () => {
  assert.deepEqual(readForm({}).problems, ['Say in a sentence what the module is for.', 'Give its page a short name (at most 24 letters).']);
  const f = readForm({ purpose: 'Keep quotes', page: 'Quotes', leaves: 'https://rates.example.org/v1, nothing, not an address!' });
  assert.deepEqual(f.hosts, ['rates.example.org']); assert.match(f.problems[0], /not addresses the desk can name: not, an, address!/);
  const g = readForm({ purpose: 'Keep quotes`; process.exit()', page: 'Quotes', keeps: '<img src=x> https://evil.example/x', tools: 'add a quote\n‮evil' });
  const st = makeStarter(g, { testhost: '// host\n' });
  assert.doesNotMatch(st.files['server.js'] + st.files['ui.js'], /<img|evil\.example|‮|process\.exit/);
  assert.equal(toolName('q', 'Add a quote from a supplier please', new Set(['q_add_a_quote_from'])), 'q_add_a_quote_from_2');
});

test('the starter takes a free id and number, starts off, and is a switch-on module', () => {
  const st = makeStarter(readForm({ purpose: 'Keep the quotes my suppliers send', page: 'Settings' }), { usedIds: ['settings'], usedNumbers: [61, 62], testhost: '// host\n' });
  assert.equal(st.id, 'settings-2'); assert.equal(st.manifest.number, 63);
  assert.equal(st.manifest.kind, 'switch-on'); assert.equal(st.manifest.defaultOn, false); assert.equal(st.manifest.status, 'stub');
  assert.equal(st.files['testhost.js'], '// host\n', 'the kit\'s test host, unchanged');
});

test('a model\'s answer: only plain module files are taken, the test host stays the kit\'s, and the changes are listed', () => {
  const text = 'I changed two files.\n=== FILE: server.js ===\n```js\nexport async function activate() {}\n```\n=== END FILE ===\n=== FILE: ../evil.js ===\nx\n=== END FILE ===\n=== FILE: testhost.js ===\nx\n=== END FILE ===\n=== FILE: lib/calc.js ===\nexport const a = 1;\n=== END FILE ===';
  const r = readAnswer(text);
  assert.deepEqual(Object.keys(r.files).sort(), ['lib/calc.js', 'server.js']);
  assert.equal(r.files['server.js'], 'export async function activate() {}\n');
  assert.equal(r.skipped.length, 2); assert.equal(r.note, 'I changed two files.');
  assert.deepEqual(changes({ 'server.js': 'a\n', 'ui.js': 'b\n' }, { 'server.js': 'a\nb\n', 'ui.js': 'b\n', 'lib/calc.js': 'c\n' }), ['server.js: changed (2 lines, was 1)', 'lib/calc.js: added (1 lines)']);
  const msgs = buildPrompt({ form: readForm({ purpose: 'Keep quotes', page: 'Quotes' }), starter: { files: { 'server.js': 'S', 'testhost.js': 'T' } }, guide: 'GUIDE TEXT', contract: 'CONTRACT TEXT' });
  assert.match(msgs[0].content, /CONTRACT TEXT[\s\S]*GUIDE TEXT/); assert.match(msgs[1].content, /=== FILE: server\.js ===\nS/); assert.doesNotMatch(msgs[1].content, /testhost/);
  assert.equal(costWords({ provider: 'router' }), 'free'); assert.equal(costWords({ provider: 'openrouter', model: 'x/y:free' }), 'free');
  assert.match(costWords({ provider: 'openai', model: 'gpt' }), /^cost not known/);
});

test('add a skill from a file: the check, hidden characters counted and taken out, scripts left out, then the Agents route adds the text', async () => {
  const t = await testDesk({ modules: ['store', 'agents'] });
  try {
    await t.call('/api/modules/agents/on', { method: 'POST' });
    const bad = await t.call('/api/m/store/skill-check', { body: { files: [{ path: 'k01-tagchars/SKILL.md', text: fs.readFileSync(path.join(SKILLS, 'k01-tagchars', 'SKILL.md'), 'utf8') }] } });
    assert.equal(bad.status, 200); assert.ok(bad.json.red > 0); assert.ok(bad.json.hiddenRemoved > 0);
    assert.doesNotMatch(bad.json.body, /[\u{E0000}-\u{E007F}]/u, 'the text shown is the text without them');
    const files = [{ path: 'tidy/SKILL.md', text: '---\nname: tidy-lists\ndescription: Use when a list needs sorting.\n---\n# Tidy lists\n\n1. Sort the list.\n2. Remove repeats.\n3. Check the result by eye.\n' }, { path: 'tidy/scripts/sort.sh', text: '' }];
    const ok = await t.call('/api/m/store/skill-check', { body: { files } });
    assert.equal(ok.json.red, 0, JSON.stringify(ok.json.lines)); assert.deepEqual(ok.json.leftOut, ['scripts/sort.sh']);
    assert.equal(ok.json.title, 'Tidy lists'); assert.match(ok.json.body, /^# Tidy lists/);
    const climb = await t.call('/api/m/store/skill-check', { body: { files: [{ path: 'a/SKILL.md', text: '# x' }, { path: 'a/../../x.md', text: 'x' }] } });
    assert.equal(climb.status, 400);
    const added = await t.call('/api/m/agents/skills', { body: { title: ok.json.title, body: ok.json.body, description: ok.json.description } });
    assert.equal(added.status, 200); assert.equal(added.json.custom, true);
    assert.ok((await t.call('/api/m/agents/catalog')).json.skills.some((s) => s.title === 'Tidy lists' && s.custom));
  } finally { await t.close(); }
});
