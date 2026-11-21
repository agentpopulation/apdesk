// Bench's money choice and session limits, as plain rules with no I/O, so the tests walk them in milliseconds.
// Before Bench runs any research it must have a money choice; the caps and limits here decide when it winds down or stops.
// Keys and paid switching stay owner-only through the Models door: 'paid' here only lets Bench prefer a paid route where
// paid use is already allowed. It never turns paid on by itself.

/** The three money choices. */
export const OPTIONS = ['local', 'free', 'paid'];
export const OPTION_WORDS = Object.freeze({ local: 'Local only', free: 'Free', paid: 'Paid, capped' });

/** Session limits that hold whatever the money choice is. At 80% of any one Bench winds down to cheaper/local routes;
 *  at 100% it stops, checkpoints and lists what is left. sources are pages fetched, steps are model calls, minutes are
 *  minutes of work (not time away), tasks are activities started. */
export const LIMITS = Object.freeze({ tasks: 12, sources: 140, steps: 140, minutes: 360 });

/** A gate with no choice made yet. */
export const GATE_DEFAULTS = Object.freeze({ option: null, chosen: false, capSessionMinor: 0, capDayMinor: 0, limits: { ...LIMITS } });

/** A money choice has been made and names one of the three options. */
export function gateReady(gate) {
  return !!gate && gate.chosen === true && OPTIONS.includes(gate.option);
}

/**
 * The model mode Bench may use right now, after the money caps. local and free never spend, so their caps never bite.
 * 'paid' falls back to 'free' once the per-session or per-day cap is reached, and the gate is marked invalid so it
 * reappears for the owner to raise a cap or re-choose. spend values are in minor units of the owner's currency.
 * -> { mode: 'local'|'free'|'paid'|null, invalid, why }
 */
export function effectiveMode(gate, { daySpend = 0, sessionSpend = 0 } = {}) {
  if (!gateReady(gate)) return { mode: null, invalid: true, why: 'no spend choice yet' };
  if (gate.option !== 'paid') return { mode: gate.option, invalid: false, why: '' };
  const capDay = Number(gate.capDayMinor) || 0;
  const capSession = Number(gate.capSessionMinor) || 0;
  if (capDay && daySpend >= capDay) return { mode: 'free', invalid: true, why: 'the day spend cap was reached' };
  if (capSession && sessionSpend >= capSession) return { mode: 'free', invalid: true, why: 'the session spend cap was reached' };
  return { mode: 'paid', invalid: false, why: '' };
}

/**
 * How close the session is to its limits. used: { tasks, sources, steps, minutes }.
 * -> { frac, which, winding (>=80% and <100%), stop (>=100%), limits, used }
 */
export function limitStatus(limits, used) {
  const L = { ...LIMITS, ...(limits || {}) };
  const u = { tasks: 0, sources: 0, steps: 0, minutes: 0, ...(used || {}) };
  let top = 0; let which = null;
  for (const k of Object.keys(L)) { const frac = L[k] > 0 ? u[k] / L[k] : 0; if (frac > top) { top = frac; which = k; } }
  return { frac: top, which, winding: top >= 0.8 && top < 1, stop: top >= 1, limits: L, used: u };
}

/** The word shown for a limit when it is the one winding the session down. */
export const LIMIT_WORDS = Object.freeze({ tasks: 'tasks', sources: 'sources fetched', steps: 'steps', minutes: 'minutes of work' });

/** Clamp and round a cap the owner typed (in minor units); never negative. */
export function cleanCap(n) { const v = Math.round(Number(n)); return Number.isFinite(v) && v > 0 ? v : 0; }

/** Clean one owner-set session limit, keeping the default when the value is not a sane positive number. */
export function cleanLimits(patch) {
  const out = { ...LIMITS };
  for (const k of Object.keys(LIMITS)) { const v = Math.round(Number(patch?.[k])); if (Number.isFinite(v) && v > 0) out[k] = v; }
  return out;
}
