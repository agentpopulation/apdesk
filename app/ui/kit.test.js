// The shell kit in plain Node (a small fake page): formatters never throw on a stored value the browser does not accept,
// small money is true, counts read right for one, and a toast never shows raw program text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document, window } = parseHTML('<!doctype html><html><body><div id="toasts"></div><div id="modal" hidden></div></body></html>');
globalThis.document = document; globalThis.Node = window.Node;
const kit = await import('./kit.js');
const { fmt, setPrefs, plural, toast, plainError, needs, h } = kit;
const iso = '2026-11-22T10:30:00.000Z';
const device = Intl.DateTimeFormat().resolvedOptions();

test('a stored zone, locale or currency the browser does not accept never makes a formatter throw', () => {
  setPrefs({ timeZone: 'Mars/Base', locale: 'xx_bad', currency: 'rupees' });
  for (const f of [fmt.time, fmt.date, fmt.when]) { const s = f(iso); assert.ok(s && !/invalid/i.test(s), String(s)); }
  assert.match(fmt.money(123400), /1,?234/);
  assert.doesNotMatch(fmt.money(123400), /rupees|undefined|NaN/);
  assert.equal(fmt.time(iso), new Date(iso).toLocaleTimeString(device.locale, { hour: 'numeric', minute: '2-digit', timeZone: device.timeZone }));
  assert.equal(fmt.time('not a date'), ''); assert.equal(fmt.when('not a date'), '');
});

test('a locale typed with an underscore is read as the same locale with a hyphen', () => {
  setPrefs({ timeZone: 'Europe/London', locale: 'en_GB', currency: 'GBP' });
  assert.equal(fmt.date('2026-11-22T10:30:00Z'), new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' }));
  assert.match(fmt.money(250000), /£2,500/);
});

test('a currency code the browser does not know is shown as the plain number', () => {
  setPrefs({ timeZone: 'UTC', locale: 'en-US', currency: 'ZZZ' });
  assert.doesNotMatch(fmt.money(123400), /ZZZ/);
  assert.equal(fmt.money(123400), '1,234');
});

test('"today" follows the owner\'s zone, not the browser\'s', (t) => {
  process.env.TZ = 'UTC';   // the browser's own zone in this test
  setPrefs({ timeZone: 'Pacific/Kiritimati', locale: 'en-US', currency: '' });   // UTC+14
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-22T09:30:00Z') });   // 23:30 on 22 Nov there, 09:30 here
  // 10:00 on 22 Nov there, but 21 Nov in the browser's zone: the same day for the owner, so a time of day only
  assert.equal(fmt.when('2026-11-21T20:00:00Z'), fmt.time('2026-11-21T20:00:00Z'));
  t.mock.timers.setTime(Date.parse('2026-11-22T11:00:00Z'));   // 01:00 on 23 Nov there, 11:00 on 22 Nov here
  // 23:00 on 22 Nov there, the same day as now in the browser's zone: yesterday for the owner, so the date shows
  assert.equal(fmt.when('2026-11-22T09:00:00Z'), 'Nov 22, ' + fmt.time('2026-11-22T09:00:00Z'));
});

test('a date that cannot be read gives an empty "ago", and a small negative amount keeps its sign', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-22T10:00:00Z') });
  assert.equal(fmt.ago('garbage'), '');
  assert.equal(fmt.ago('2026-11-22T09:58:00Z'), '2 min ago');
  assert.equal(fmt.ago('2026-11-19T10:00:00Z'), '3 d ago');
  setPrefs({ timeZone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR' });
  assert.equal(fmt.money(0.3), 'less than ₹0.01');
  assert.equal(fmt.money(-0.3), 'less than ₹0.01 below zero');
  assert.equal(fmt.money(-42), '-₹0.42');
});

test('small amounts are never shown as zero', () => {
  setPrefs({ timeZone: 'UTC', locale: 'en-US', currency: 'USD' });
  assert.equal(fmt.money(0), '$0');
  assert.equal(fmt.money(40), '$0.40');
  assert.equal(fmt.money(4), '$0.04');
  assert.equal(fmt.money(0.4), 'less than $0.01');
  assert.equal(fmt.money(149), '$1.49');
  assert.equal(fmt.money(100), '$1');
  assert.equal(fmt.money(123400), '$1,234');
  assert.equal(fmt.money(-40), '-$0.40');
  setPrefs({ locale: 'en-IN', currency: 'INR' });
  assert.equal(fmt.money(42), '₹0.42');
  assert.equal(fmt.money(0.2), 'less than ₹0.01');
});

test('plural writes the number with the right word', () => {
  assert.equal(plural(1, 'source'), '1 source');
  assert.equal(plural(0, 'source'), '0 sources');
  assert.equal(plural(2, 'source'), '2 sources');
  assert.equal(plural(1, 'page', 'pages read'), '1 page');
  assert.equal(plural(3, 'entry', 'entries'), '3 entries');
  assert.equal(plural(1234, 'file'), '1,234 files');
});

test('a toast never shows raw program text; the raw text goes to the console', () => {
  const seen = []; const warn = console.warn; console.warn = (...a) => seen.push(a.join(' '));
  try {
    const raws = ['fetch failed', 'Failed to fetch', 'Request failed (502)', "Cannot read properties of undefined (reading 'x')", 'connect ECONNREFUSED 127.0.0.1:8787', 'Unexpected token < in JSON at position 0', '[object Object]', 'undefined', 'SQLITE_CONSTRAINT: UNIQUE constraint failed: t.id',
      "ENOENT: no such file or directory, open '/home/u/x'", 'EACCES: permission denied', '{"error":{"message":"Invalid API key"}}', '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>', 'C:\\Users\\me\\data is locked'];
    for (const raw of raws) {
      const el = toast(raw, 'err');
      assert.ok(!/fetch|Request failed|Cannot read|ECONN|Unexpected token|object Object|undefined|SQLITE|ENOENT|EACCES|home|Invalid API|DOCTYPE|Gateway|Users/.test(el.textContent), raw + ' -> ' + el.textContent);
      assert.ok(el.textContent.length > 8 && el.textContent.length < 120);
    }
    assert.ok(seen.length >= raws.length, 'raw text kept in the console');
    assert.equal(toast('Saved.').textContent, 'Saved.');
    assert.equal(toast('A post needs some text.', 'err').textContent, 'A post needs some text.');
    assert.equal(toast('Every agent can read this. Enter a name.', 'err').textContent, 'Every agent can read this. Enter a name.');
    assert.equal(toast('Moved 2 items to Files and/or the Bin.', 'ok').textContent, 'Moved 2 items to Files and/or the Bin.');
    assert.equal(plainError('Type a token first.'), 'Type a token first.');
  } finally { console.warn = warn; }
});

test('the plain line tells apart: the desk not reached, this PC not online, a provider not reached, anything else', async () => {
  const warn = console.warn; console.warn = () => {};
  const fetch0 = globalThis.fetch;
  try {
    // the desk itself did not answer: the browser's fetch threw, no status came back
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    const down = await kit.api('settings').catch(e => e);
    assert.equal(plainError(down), kit.PLAIN.deskDown);
    assert.equal(plainError(new TypeError('Load failed')), kit.PLAIN.deskDown);
    // the desk answered, but a program it uses (a local engine) did not: never "the desk did not answer"
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'connect ECONNREFUSED 127.0.0.1:11434' }), { status: 400 });
    const unreached = await kit.api('m/models/test').catch(e => e);
    assert.equal(unreached.status, 400);
    assert.equal(plainError(unreached), kit.PLAIN.unreached);
    assert.equal(plainError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { status: 400 })), kit.PLAIN.unreached);
    // the desk sent its own code and line
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'This PC is not online. Local models still work.', code: 'not_online' }), { status: 503 });
    assert.equal(plainError(await kit.api('m/models/test').catch(e => e)), kit.PLAIN.notOnline);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Only the keeper can change this.' }), { status: 403 });
    assert.equal(plainError(await kit.api('settings', { body: {} }).catch(e => e)), 'Only the keeper can change this.');
    // a 502 with an error page and no line
    globalThis.fetch = async () => new Response('<!DOCTYPE html><title>502 Bad Gateway</title>', { status: 502 });
    assert.equal(plainError(await kit.api('settings').catch(e => e)), kit.PLAIN.general);
    // a stop the page asked for stays a stop
    globalThis.fetch = async () => { throw new DOMException('The operation was aborted.', 'AbortError'); };
    assert.equal((await kit.api('settings').catch(e => e)).name, 'AbortError');
  } finally { globalThis.fetch = fetch0; console.warn = warn; }
});

test('the save mark shows the plain line, in the words and the hover text, and puts the old value back', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const m = kit.savedMark(); const input = h('input', { type: 'text' }); input.value = 'new';
    const ok = await m.run(async () => { throw Object.assign(new Error('Failed to fetch'), { deskDown: true }); }, { field: input, old: 'old' });
    assert.equal(ok, false);
    assert.equal(input.value, 'old');
    assert.equal(m.textContent, 'Not saved: ' + kit.PLAIN.deskDown);
    assert.equal(m.title, 'Not saved: ' + kit.PLAIN.deskDown);
    await m.run(async () => { throw new Error("ENOENT: no such file or directory, open '/x/y'"); });
    assert.doesNotMatch(m.title + m.textContent, /ENOENT|\/x/);
    await m.run(async () => { throw new Error('That address is not on your own network.'); });
    assert.equal(m.textContent, 'Not saved: That address is not on your own network.');
    assert.equal(await m.run(async () => ({})), true);
    assert.equal(m.dataset.saved, 'ok');
  } finally { console.warn = warn; }
});

test('an empty field is answered beside the field and the note goes when the owner types', () => {
  const row = h('div', null, h('input', { type: 'text' }), h('button', null, 'Save'));
  const input = row.firstChild;
  assert.equal(needs(input, 'Type a token first.'), false);
  assert.equal(row.children[1].textContent, 'Type a token first.');
  needs(input, 'Type a token first.');
  assert.equal(row.querySelectorAll('[role=alert]').length, 1, 'pressed twice, one note');
  input.dispatchEvent(new window.Event('input'));
  assert.equal(row.querySelectorAll('[role=alert]').length, 0);
});

test('a toast given an element shows that element', () => {
  const el = h('b', null, 'Done');
  assert.equal(toast(el).textContent, 'Done');
});
