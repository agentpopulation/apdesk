// Section B and F charts: the geometry is sensible for 0, 1, 2 and 200 points, and axis labels are plain units.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lineModel, barModel } from './ui-chart.js';

const T = Date.UTC(2026, 10, 21, 6, 0);
const pts = (n, f) => Array.from({ length: n }, (_, i) => ({ t: T + i * 3600_000, v: f(i) }));

test('no points: an empty chart, not an error', () => { const m = lineModel([{ name: 'a', points: [] }]); assert.equal(m.empty, true); });

test('one point: a dot in the middle, an hour either side, the y axis from 0', () => {
  const m = lineModel([{ name: 'down', points: [{ t: T, v: 42 }] }], { width: 400, height: 200, valueLabel: (v) => `${v} Mbps` });
  assert.equal(m.lines[0].dots.length, 1); assert.equal(m.lines[0].d, '', 'no line for one point');
  const x = m.lines[0].dots[0].x; assert.ok(Math.abs(x - (m.pad.l + (400 - m.pad.l - m.pad.r) / 2)) < 1, 'centred');
  assert.equal(m.y[0].label, '0 Mbps'); assert.ok(m.y.at(-1).label.endsWith(' Mbps')); assert.ok(Number.parseFloat(m.y.at(-1).label) >= 42);
});

test('two points: a line from the left edge to the right edge', () => {
  const m = lineModel([{ name: 'a', points: pts(2, (i) => 10 + i * 10) }], { width: 400 });
  assert.match(m.lines[0].d, /^M[\d.]+,[\d.]+ L[\d.]+,[\d.]+$/);
  assert.equal(m.lines[0].dots[0].x, m.pad.l); assert.equal(m.lines[0].dots[1].x, 400 - m.pad.r);
});

test('200 points: one path, no dots, all inside the frame, at most a few x labels', () => {
  const m = lineModel([{ name: 'a', points: pts(200, (i) => 50 + 30 * Math.sin(i / 7)) }, { name: 'b', points: pts(200, (i) => (i % 9 === 0 ? null : 20)) }], { width: 600, height: 180 });
  assert.equal(m.lines[0].dots.length, 0);
  const xy = m.lines[0].d.slice(1).split(' L').map(p => p.split(',').map(Number));
  assert.equal(xy.length, 200);
  assert.ok(xy.every(([x, y]) => x >= m.pad.l && x <= 600 - m.pad.r && y >= m.pad.t && y <= 180 - m.pad.b));
  assert.ok(m.x.length <= 6 && m.x.length >= 2);
  assert.ok(m.lines[1].d.split(' L').length < 200, 'missing values are skipped, not drawn as zero');
});

test('bars scale to the largest value', () => {
  const b = barModel([{ label: 'Fast', v: 100 }, { label: 'Slow', v: 400 }, { label: 'None', v: null }], { width: 500 });
  assert.equal(b.bars.length, 2); assert.ok(b.bars[1].w > b.bars[0].w * 3.5);
});
