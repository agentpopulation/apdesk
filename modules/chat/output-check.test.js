// The desk's checks on its own output: readable text, and figures only from pages read or records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { usableReply, checkFigures, figuresIn, placeLine, NO_USABLE } from './output-check.js';
import { readPlanText, parsePlan, answeredParts, names, PLAN_SYSTEM } from './research.js';
import { summaryWrong, plainList } from './coordinator.js';

// a reply seen on screen for "Hi, I run a small bakery in Pune that delivers to offices." (shortened, same shape)
const BAKERY_REPLY = 'not checked\n\nnot checked\n\nThe only bakery-related brand named on the pages with a presence in Pune is WS Bakers, a chain of pure vegetarian cakes and pastries across the city [5]. No other Pune bakery names appear on the pages.\n\nPage 6 describes a pricing approach: work out the true cost of each item, look at what nearby bakeries charge, and price on value rather than on price alone [6].\n\nSure, fine...\n\nWe need your *fir​[?t]??​......…...\n\nOK...\n\nWehelp... uh??? \r\n\r\n\r\n\r\ncopy‑?..…??????先…\n\nThe lack…?........….... \n\nWe….....??\n\nI’m sorry, but I can’t help with that.';

test('a reply that ends in babble keeps its readable part; the babble, the bare "not checked" lines and the refusal go', () => {
  const u = usableReply(BAKERY_REPLY, { ownerText: 'Hi, I run a small bakery in Pune that delivers to offices.' });
  assert.equal(u.ok, true);
  assert.match(u.text, /^The only bakery-related brand/); assert.match(u.text, /price on value/);
  for (const junk of ['fine...', '??', '先', 'OK...', 'sorry', 'not checked\n']) assert.ok(!u.text.includes(junk), junk);
});

test('a reply that is mostly broken characters, a bare refusal, or only fragments is not usable', () => {
  assert.equal(usableReply('I’m sorry, but I can’t help with that.').ok, false);
  assert.equal(usableReply('Sure, fine...\n\nOK...\n\nWe….....??').ok, false);
  assert.equal(usableReply('??????先…\n\n�� ��\n\nok').ok, false);
  assert.equal(usableReply('not checked\n\nnot checked').ok, false);
  assert.equal(usableReply('').ok, false);
  assert.equal(usableReply('ốngốngốngốngốngốngốngốngốngốngốngốngống').ok, false, 'a model stuck repeating one sound (seen on a real free model)');
  // a one-line reply that stops mid-sentence (seen on a real free model after its tool steps)
  assert.equal(usableReply('That gives us a clear starting point: an office delivery').ok, false);
  assert.equal(usableReply('Here is what I would do first for the').ok, false);
  assert.equal(usableReply('The answer would be that offices like early morning deliveries', { cut: true }).ok, false);
  assert.equal(usableReply('### VR200 overview\n\nThe VR200 is the rack after Blackwell.\n\n---\n\n### 1. Key specs: VR200 vs. GB200').ok, false, 'a reply that stops on a heading (seen on a real free model)');
  const cutLong = usableReply('### VR200\n\nThe VR200 is the rack after Blackwell.\n\nIt ships as the NVL72 as well as the HG', { cut: true });
  assert.equal(cutLong.ok, true); assert.equal(cutLong.text, '### VR200\n\nThe VR200 is the rack after Blackwell.'); assert.equal(cutLong.cutTail, true);
  for (const fine of ['Canberra', 'Tokyo is the capital of Japan', 'Hello! How can I help with your bakery today?', 'Total: 42']) assert.equal(usableReply(fine).ok, true, fine);
  assert.match(NO_USABLE, /^No model gave a usable answer\. Try again in a moment\.$/);
});

test('ordinary text stays as it is: headings, short questions, tables, code, a whole reply in Hindi', () => {
  for (const t of ['### Compute\n\nThe GPU has 80 GB.\n\nWhat next?', '| Day | Plan |\n|---|---|\n| 1 | Fort |', 'Run this:\n\n```js\nconsole.log("??...")\n```', 'Hello! How can I help with your bakery today?']) {
    const u = usableReply(t, { ownerText: 'hi' }); assert.equal(u.ok, true, t); assert.equal(u.text, t.trim(), t);
  }
  assert.equal(usableReply('नमस्ते! मैं आपकी बेकरी के लिए एक छोटा प्लान बना सकता हूँ।', { ownerText: 'Say hello in Hindi' }).ok, true);
  assert.equal(usableReply('Here is the plan.\n\n先先先先先先先先 先先先先 ??', { ownerText: 'Plan my week' }).text, 'Here is the plan.', 'letters of another script in a mixed-up line are junk');
});

test('figures: one a page read gave stays; one no page gave is marked on the figure; a placeholder line is dropped', () => {
  const pages = ['GB200 NVL72: 372 GB HBM3E per superchip, 16 TB/s bandwidth. 13.4 TB in all. 1,440 PFLOPS FP4 per rack.'];
  const given = figuresIn(...pages, 'my question');
  const answer = '- GPU memory: 372 GB HBM3E [4].\n- Compute: NVFP4 2 × ? PFLOPS: 1 440 PFLOPS per rack\n- Bandwidth: 16 TB/s, later 20 TB/s; 50 PFLOPS NVFP4.\n- 1,440 PFLOPS per rack, 72 GPUs, in 2026, step 2.';
  const r = checkFigures(answer, { given, currency: 'INR' });
  assert.equal(r.text, '- GPU memory: 372 GB HBM3E [4].\n- Bandwidth: 16 TB/s, later 20 TB/s (not checked); 50 PFLOPS (not checked) NVFP4.\n- 1,440 PFLOPS per rack, 72 GPUs, in 2026, step 2.');
  assert.equal(r.dropped, 1); assert.equal(r.marked, 2);
  // a unit the page did not give with that number is not the page's figure
  assert.equal(checkFigures('It has 16 GB.', { given, currency: 'INR' }).text, 'It has 16 GB (not checked).');
  assert.equal(checkFigures('Bandwidth 16 TB/s (not checked).', { given, currency: 'INR' }).text, 'Bandwidth 16 TB/s.', 'a mark the model wrote itself is put right by the rule');
});

test('money: an amount no page gave is marked, and one in another currency is marked even when a page gave the number', () => {
  const given = figuresIn('The rack costs $3M, about ₹25 lakh a unit.');
  const r = checkFigures('Expect $3–5M+ per rack, ~$3M, ₹25–35 Lakh (~$30–42K). A 20% margin on 3 offices.', { given, currency: 'INR' });
  assert.equal(r.text, 'Expect $3–5M+ (not checked) per rack, ~$3M (not checked), ₹25–35 Lakh (not checked) (~$30–42K (not checked)). A 20% (not checked) margin on 3 offices.');
  assert.equal(checkFigures('About ₹25 lakh a unit.', { given, currency: 'INR' }).text, 'About ₹25 lakh a unit.');
  assert.equal(checkFigures('Price: $30.', { given: figuresIn('$30'), currency: 'USD' }).text, 'Price: $30.');
  assert.equal(checkFigures('See [12] and `2 GB` in code.\n```\n5 GB\n```', { given, currency: 'INR' }).text, 'See [12] and `2 GB` in code.\n```\n5 GB\n```');
});

test('every writer is told the owner\'s place and money and that a figure needs a page or a record', () => {
  const l = placeLine({ country: 'IN', currency: 'INR', locale: 'en-IN' });
  assert.match(l, /in India/); assert.match(l, /\(INR\)/); assert.match(l, /never convert another currency by guess/); assert.match(l, /needs a page read in this turn or a record of the desk/);
  assert.match(placeLine({}), /needs a page read in this turn or a record of the desk/);
});

test('the plan prompt asks the one question: does the owner ask to find something out that needs facts from outside', () => {
  assert.match(PLAN_SYSTEM, /does the owner ASK to find something out that needs facts from outside/);
  for (const w of ['A statement', 'a greeting', 'an introduction', 'an instruction about how to work', 'a question about his own business']) assert.ok(PLAN_SYSTEM.includes(w), w);
  assert.match(PLAN_SYSTEM, /When unsure, false\./); assert.match(PLAN_SYSTEM, /today's date/);
});

test('a plan cut off is mended; a mended plan with no parts is no plan; text that is not an object is no plan', () => {
  let r = readPlanText('{"needsFacts": true'); assert.deepEqual(r, { json: { needsFacts: true }, cut: true }); assert.equal(parsePlan(r.json, 'ask', { cut: r.cut }), null);
  r = readPlanText('{"needsFacts": true, "parts": ["NVIDIA VR200 GPU", "NVIDIA GB'); assert.deepEqual(r.json, { needsFacts: true, parts: ['NVIDIA VR200 GPU'] });
  assert.deepEqual(parsePlan(r.json, 'ask', { cut: true }).parts, ['NVIDIA VR200 GPU']);
  assert.deepEqual(readPlanText('Key differences between NVIDIA VR200, GB'), { json: null, cut: false });
  assert.deepEqual(readPlanText('```json\n{"needsFacts": false, "parts": [], "compare": ""}\n```').json, { needsFacts: false, parts: [], compare: '' });
});

test('a part is answered only when the answer says something about it that a page read supports', () => {
  const pages = [{ n: 1, url: 'https://a.example/vr', text: 'The VR200 rack pairs a Vera CPU with Rubin GPUs and HBM4 memory.' }, { n: 2, url: 'https://b.example/h100', text: 'NVIDIA H100 page: the page did not render its specification table.' }];
  const parts = ['NVIDIA VR200 GPU', 'NVIDIA H100 GPU'];
  const a = '**NVIDIA VR200 (Vera Rubin)** [1]\n- Pairs a Vera CPU with Rubin GPUs [1].\n\n**NVIDIA H100 (Hopper)** [2]\n- Memory: not checked.\n- Interconnect, CPU pairing and die layout are not checked [2].';
  assert.deepEqual(answeredParts(a, parts, pages), ['NVIDIA VR200 GPU']);
  // a table: each part's column
  const tbl = '| Spec | NVIDIA VR200 | NVIDIA H100 |\n|---|---|---|\n| Memory | HBM4 memory [1] | not checked |';
  assert.deepEqual(answeredParts(tbl, parts, pages), ['NVIDIA VR200 GPU']);
  assert.deepEqual(answeredParts('VR200: not checked.\nH100: not checked.', parts, pages), []);
  // naming: a model name names the part; other parts by most of their words
  assert.ok(names('The H100 (Hopper)', 'NVIDIA H100 GPU')); assert.ok(names('bakery rules in Pune', 'bakery delivery regulations in Pune')); assert.ok(!names('Auto rickshaw', 'bakery delivery regulations in Pune'));
});

test('a group summary is checked against the record: no one named who did not answer, no one left out, no wrong count', () => {
  assert.equal(summaryWrong('Scout: a list. Closer: a script. Next: call.', ['Scout', 'Closer'], ['Operator', 'Coder']), null);
  assert.match(summaryWrong('Scout: a list. Operator: a script.', ['Scout', 'Closer'], ['Operator']), /names Operator, who did not answer/);
  assert.match(summaryWrong('Scout: a list. All three agree.', ['Scout'], []), /all three/i);
  assert.match(summaryWrong('Scout: a. Closer: b. All three agree.', ['Scout', 'Closer'], []), /"All three" but 2 answered/i);
  assert.equal(plainList([{ agentId: 'scout', text: '**Plan:** visit ten offices. Then call.' }, { agentId: 'closer', text: 'Send a sample box.' }]), 'Researcher: Plan: visit ten offices.\nSales expert: Send a sample box.');
  // an agent may be named by any of its names; a role that did not answer counts only written as a name
  assert.equal(summaryWrong('Kent: a list. The Sales expert: a script.', [['Kent · Researcher', 'Kent', 'Researcher'], ['Sales expert']], [{ as: 'Coder', exact: true }]), null);
  assert.equal(summaryWrong('Kent: ask a coder later.', [['Kent']], [{ as: 'Coder', exact: true }]), null);
  assert.match(summaryWrong('Kent: a list. Coder: a script.', [['Kent']], [{ as: 'Coder', exact: true }]), /names Coder, who did not answer/);
});

test('a figure a CRM tool returned is the owner\'s own record, in his number style too: it is not marked "not checked"', () => {
  const given = figuresIn(JSON.stringify({ deals: [{ title: 'Rao Exports annual order', value: '₹3,50,000', close: '28 Nov 2026' }, { title: 'Big order', value: '₹12,25,000' }] }));
  const r = checkFigures('The Rao Exports deal is worth ₹3,50,000 and the big one ₹12,25,000.', { given, currency: 'INR' });
  assert.equal(r.marked, 0, r.text);
  assert.equal(checkFigures('Another is worth ₹4,10,000.', { given, currency: 'INR' }).marked, 1, 'a figure no record gave is still marked');
});
