// Spend gate: the money choice and the session limits, as plain rules (no desk, no clock).
import test from 'node:test';
import assert from 'node:assert/strict';
import { OPTIONS, LIMITS, GATE_DEFAULTS, gateReady, effectiveMode, limitStatus, cleanCap, cleanLimits } from './spendgate.js';

test('a gate is ready only once a money choice is made and named', () => {
  assert.equal(gateReady(null), false);
  assert.equal(gateReady(GATE_DEFAULTS), false, 'the default gate has no choice yet');
  assert.equal(gateReady({ chosen: true, option: 'free' }), true);
  assert.equal(gateReady({ chosen: true, option: 'nonsense' }), false);
  assert.equal(gateReady({ chosen: false, option: 'free' }), false, 'an option without the choice made does not count');
  for (const o of OPTIONS) assert.equal(gateReady({ chosen: true, option: o }), true);
});

test('local and free never spend, so their caps never bite', () => {
  assert.deepEqual(effectiveMode({ chosen: true, option: 'local' }, { daySpend: 1e9 }).mode, 'local');
  assert.deepEqual(effectiveMode({ chosen: true, option: 'free' }, { sessionSpend: 1e9 }).mode, 'free');
});

test('an unset gate yields no mode and is invalid', () => {
  const r = effectiveMode(GATE_DEFAULTS, {});
  assert.equal(r.mode, null); assert.equal(r.invalid, true);
});

test('paid falls back to free when a cap is reached, and marks the gate invalid so it reappears', () => {
  const gate = { chosen: true, option: 'paid', capSessionMinor: 5000, capDayMinor: 20000 };
  assert.deepEqual(effectiveMode(gate, { daySpend: 100, sessionSpend: 100 }), { mode: 'paid', invalid: false, why: '' });
  const day = effectiveMode(gate, { daySpend: 20000, sessionSpend: 0 });
  assert.equal(day.mode, 'free'); assert.equal(day.invalid, true); assert.match(day.why, /day/);
  const sess = effectiveMode(gate, { daySpend: 0, sessionSpend: 5000 });
  assert.equal(sess.mode, 'free'); assert.equal(sess.invalid, true); assert.match(sess.why, /session/);
  // a zero cap means no cap on that axis
  assert.equal(effectiveMode({ chosen: true, option: 'paid', capSessionMinor: 0, capDayMinor: 0 }, { daySpend: 1e9, sessionSpend: 1e9 }).mode, 'paid');
});

test('session limits: 80% winds down, 100% stops, and the busiest axis is named', () => {
  const at50 = limitStatus(LIMITS, { steps: 70 });
  assert.equal(at50.winding, false); assert.equal(at50.stop, false);
  const at80 = limitStatus(LIMITS, { steps: Math.ceil(LIMITS.steps * 0.8) });
  assert.equal(at80.winding, true); assert.equal(at80.stop, false); assert.equal(at80.which, 'steps');
  const at100 = limitStatus(LIMITS, { minutes: LIMITS.minutes });
  assert.equal(at100.winding, false); assert.equal(at100.stop, true); assert.equal(at100.which, 'minutes');
  // the busiest axis wins even across kinds
  assert.equal(limitStatus(LIMITS, { tasks: 11, sources: 10 }).which, 'tasks');
});

test('owner input is cleaned: caps are positive whole minor units, limits keep their default when unsound', () => {
  assert.equal(cleanCap('500.6'), 501); assert.equal(cleanCap(-3), 0); assert.equal(cleanCap('x'), 0); assert.equal(cleanCap(0), 0);
  assert.deepEqual(cleanLimits({ steps: 50, sources: -1, minutes: 'x', tasks: 3 }), { ...LIMITS, steps: 50, tasks: 3 });
});
