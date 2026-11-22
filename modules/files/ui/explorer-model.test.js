import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDate } from './explorer-model.js';

// the same formatter the shell kit uses, in a fixed zone and style
const fmt = {
  date: (iso) => new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }),
  time: (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
  when: (iso) => new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) + ', ' + new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
};

test('the list shows a short date in the owner\'s zone (no year this year, no time in other years); the pane shows it in full', () => {
  const thisYear = new Date(); thisYear.setUTCMonth(0, 2); thisYear.setUTCHours(20, 30, 0, 0);   // 02:00 next morning in Kolkata
  const iso = thisYear.toISOString();
  const short = formatDate(iso, { fmt });
  assert.equal(short, fmt.when(iso)); assert.ok(short.length <= 18, short); assert.doesNotMatch(short, /\d{4}/);
  assert.match(short, /Jan 3/, 'the day in the owner\'s zone, not the browser\'s');
  assert.equal(formatDate(iso, { fmt, full: true }), `${fmt.date(iso)}, ${fmt.time(iso)}`);
  const old = '2019-03-04T10:00:00.000Z';
  assert.equal(formatDate(old, { fmt }), fmt.date(old));
  assert.equal(formatDate('', { fmt }), ''); assert.equal(formatDate('not a date', { fmt }), '');
});

test('with no formatter given the date still reads, never "Invalid Date"', () => {
  assert.doesNotMatch(formatDate('2026-11-22T10:30:00Z'), /invalid/i);
  assert.equal(formatDate('nope'), '');
});
