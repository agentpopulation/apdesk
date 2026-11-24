// An added module cannot make code from text: once the first added module is loaded, no function leads to the Function
// constructors, whatever the spelling. Run in a process of its own, because the lock stays for the life of the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const modulesJs = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'core', 'modules.js')).href;
const run = (body) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { closeCodeFromText } from ${JSON.stringify(modulesJs)};\n${body}`], { encoding: 'utf8' });

test('before the lock a function leads to the Function constructor; after it, no spelling does', () => {
  const r = run(`
    const c = 'constr' + 'uctor'; const log = () => {};
    const before = log[c]('return 7')();
    closeCodeFromText(); closeCodeFromText();
    const tries = { plain: () => log[c]('return 7')(), dot: () => (() => {}).constructor('return 7')(), twice: () => ({})[c][c]('return 7')(),
      async: () => (async () => {})[c]('return 7'), gen: () => (function* () {})[c]('yield 7'), asyncGen: () => (async function* () {})[c]('yield 7'),
      proto: () => Object.getPrototypeOf(log)[c]('return 7')(), descriptor: () => Object.getOwnPropertyDescriptor(Object.getPrototypeOf(log), c).value('return 7')(),
      reflect: () => Reflect.get(log, c)('return 7')(), klass: () => (class {})[c]('return 7')(), bound: () => log.bind(null)[c]('return 7')() };
    const out = { before };
    for (const [k, f] of Object.entries(tries)) { try { f(); out[k] = 'ran'; } catch (e) { out[k] = e.code || e.message; } }
    try { Object.defineProperty(Object.getPrototypeOf(log), c, { value: Function }); out.putBack = 'done'; } catch { out.putBack = 'refused'; }
    try { Object.getPrototypeOf(log)[c] = Function; } catch { /* refused is fine too */ } out.assigned = (() => { try { log[c]('return 7')(); return 'ran'; } catch (e) { return e.code; } })();
    function Lib() {} Lib[c] = Object; out.ownSet = Lib[c] === Object && log[c] !== Object;
    out.name = [log[c].name, (async () => {})[c].name];
    out.still = [log instanceof Function, typeof log, [1, 2].map((x) => x * 2).join()];
    console.log(JSON.stringify(out));`);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.before, 7, 'the control: before the lock the built name reaches the constructor');
  for (const k of ['plain', 'dot', 'twice', 'async', 'gen', 'asyncGen', 'proto', 'reflect', 'klass', 'bound']) assert.equal(out[k], 'code_from_text_closed', k);
  assert.notEqual(out.descriptor, 'ran', 'the property descriptor holds no constructor');
  assert.equal(out.assigned, 'code_from_text_closed', 'assigning the constructor back on the shared prototype changes nothing');
  assert.equal(out.ownSet, true, 'a library that sets .constructor on its own function still can, and only on that function');
  assert.equal(out.putBack, 'refused', 'the link cannot be put back');
  assert.deepEqual(out.name, ['Function', 'AsyncFunction'], 'code that only reads the constructor name still works');
  assert.deepEqual(out.still, [true, 'function', '2,4'], 'ordinary code is unchanged');
});
