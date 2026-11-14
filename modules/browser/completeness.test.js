// Plumbing: the loop does not take a model's "done" on trust. Fake model, stub page (no browser). Never proof that it works.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLoop, parseParts, honestResult } from './agent-loop.js';

const TASK = 'Who first climbed Everest with Tenzing Norgay, that person\'s birth year, Everest\'s height, and the year the national park was founded.';
const PARTS = ['climbing partner', 'birth year', 'height of Everest', 'park founded'];
function stubComputer() {
  let url = 'about:blank';
  const page = { url: () => url, evaluate: async (fn, arg) => (arg && typeof arg === 'object' && 'start' in arg ? { url, title: 'T', rows: [], scroll: {} } : 'page text'), waitForTimeout: async () => {} };
  return { page, mode: 'agent', driving: 'agent', ownerNotes: [], snap() {}, async goto(u) { url = u; }, async afterMove() {}, waitForOwner: () => new Promise(() => {}) };
}
const isCheck = (messages) => /check whether a browser agent finished/.test(messages[0].content);
const partsReply = (given) => ({ json: { parts: PARTS.map((p, i) => ({ part: p, given: i < given.length && given[i] != null, in_answer: i < given.length && given[i] != null, value: given[i] ?? '' })) }, label: 'Fake · model' });

test('done after the first part is not accepted: the loop carries on with "still missing" and finishes whole', async () => {
  const steps = []; const prompts = []; let calls = 0;
  const actions = [
    { action: 'done', result: 'Edmund Hillary' },
    { action: 'goto', url: 'https://en.wikipedia.org/wiki/Edmund_Hillary', notes: 'partner Edmund Hillary; born 1919' },
    { action: 'goto', url: 'https://en.wikipedia.org/wiki/Mount_Everest', notes: 'partner Edmund Hillary; born 1919; height 8,849 m' },
    { action: 'goto', url: 'https://en.wikipedia.org/wiki/Sagarmatha_National_Park', notes: 'partner Edmund Hillary; born 1919; height 8,849 m; park 1976' },
    { action: 'done', result: 'Edmund Hillary, born 1919; Everest 8,849 m; park founded 1976' },
  ];
  const checks = [partsReply(['Edmund Hillary']), partsReply(['Edmund Hillary', '1919', '8,849 m', '1976'])];
  const model = async (messages) => { calls++; if (isCheck(messages)) return checks.shift(); prompts.push(messages[1].content); return { json: actions.shift(), label: 'Fake · model' }; };
  const out = await runLoop(stubComputer(), { goal: TASK, startUrl: 'https://en.wikipedia.org/wiki/Tenzing_Norgay', model, signal: new AbortController().signal, onStep: (k, t) => steps.push(t), maxSteps: 12 });
  assert.equal(out.complete, true);
  assert.deepEqual(out.missing, []);
  assert.equal(out.result, 'Edmund Hillary, born 1919; Everest 8,849 m; park founded 1976');
  assert.equal(out.visited.length, 4);
  assert.ok(steps.some(s => /Still missing: birth year; height of Everest; park founded/.test(s)), steps.join(' | '));
  assert.match(prompts[1], /NOT DONE YET.*birth year; height of Everest; park founded/);
  assert.match(prompts[1], /Found so far: climbing partner: Edmund Hillary/, 'what was found is kept in the notes');
  assert.equal(calls, 7, '5 actions and 2 checks');
});

test('a model that keeps saying done: at most two continuations, then the result says what was found and what was not checked', async () => {
  let actionCalls = 0, checkCalls = 0;
  const model = async (messages) => { if (isCheck(messages)) { checkCalls++; return partsReply(['Edmund Hillary']); } actionCalls++; return { json: { action: 'done', result: 'Edmund Hillary' } }; };
  const out = await runLoop(stubComputer(), { goal: TASK, startUrl: 'https://en.wikipedia.org/wiki/Tenzing_Norgay', model, signal: new AbortController().signal, onStep: () => {}, maxSteps: 12 });
  assert.equal(actionCalls, 3); assert.equal(checkCalls, 3);
  assert.equal(out.complete, false);
  assert.deepEqual(out.missing, ['birth year', 'height of Everest', 'park founded']);
  assert.notEqual(out.result, 'Edmund Hillary', 'never the bare partial answer');
  assert.match(out.result, /1 of 4 parts were found/);
  assert.match(out.result, /Found:\n- climbing partner: Edmund Hillary/);
  assert.match(out.result, /Not checked:\n- birth year: not checked\n- height of Everest: not checked\n- park founded: not checked/);
});

test('no steps left: no continuation, the result is still honest; an unusable check is said plainly', async () => {
  const model = async (messages) => isCheck(messages) ? partsReply(['Edmund Hillary']) : { json: { action: 'done', result: 'Edmund Hillary' } };
  const out = await runLoop(stubComputer(), { goal: TASK, model, signal: new AbortController().signal, onStep: () => {}, maxSteps: 1 });
  assert.equal(out.steps, 1); assert.match(out.result, /Not checked:/);
  const bad = async (messages) => isCheck(messages) ? { text: 'looks fine to me' } : { json: { action: 'done', result: 'Edmund Hillary' } };
  const out2 = await runLoop(stubComputer(), { goal: TASK, model: bad, signal: new AbortController().signal, onStep: () => {}, maxSteps: 3 });
  assert.equal(out2.checked, false); assert.match(out2.result, /could not check this answer/);
});

test('Stop during the check stops the loop; Take over during the check waits for the owner', async () => {
  const ac = new AbortController();
  const model = (messages, signal) => isCheck(messages) ? new Promise((_, rej) => { signal.addEventListener('abort', () => rej(new Error('aborted'))); setTimeout(() => ac.abort(), 20); }) : Promise.resolve({ json: { action: 'done', result: 'x' } });
  await assert.rejects(runLoop(stubComputer(), { goal: TASK, model, signal: ac.signal, onStep: () => {}, maxSteps: 3 }), (e) => e.code === 'aborted');
  const c = stubComputer(); let waited = false; let checks = 0;
  c.waitForOwner = async () => { waited = true; c.mode = 'agent'; return 'The owner looked and handed back.'; };
  const model2 = (messages, signal) => { if (!isCheck(messages)) return Promise.resolve({ json: { action: 'done', result: 'all four' } }); checks++; if (checks === 1) return new Promise((_, rej) => { signal.addEventListener('abort', () => rej(new Error('aborted'))); setTimeout(() => { c.mode = 'owner'; c.onTakeOver(); }, 20); }); return Promise.resolve(partsReply(['a', 'b', 'c', 'd'])); };
  const out = await runLoop(c, { goal: TASK, model: model2, signal: new AbortController().signal, onStep: () => {}, maxSteps: 5 });
  assert.equal(waited, true); assert.equal(out.complete, true);
});

test('parts parsing and the honest result', () => {
  assert.equal(parseParts({ text: 'nope' }), null);
  const p = parseParts({ text: '```json\n{"parts":[{"part":"A","given":"yes","in_answer":true,"value":"1"},{"part":"B","given":true,"value":""}]}\n```' });
  assert.deepEqual(p.map(x => x.given), [true, false], 'given without a value does not count');
  assert.equal(honestResult('full answer', [{ part: 'A', given: true, inAnswer: true, value: '1' }]), 'full answer');
  assert.match(honestResult('1', [{ part: 'A', given: true, inAnswer: true, value: '1' }, { part: 'B', given: true, inAnswer: false, value: '2' }]), /^1\n\nFound:\n- A: 1\n- B: 2$/);
});
