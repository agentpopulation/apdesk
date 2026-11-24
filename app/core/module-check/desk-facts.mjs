// What AP Desk 0.2.0 already uses, read from modules/shipped.json, its modules/*/module.json and app/ui/shell.js (23 Nov 2026).
// The checks refuse an added module that takes one of these ids, numbers or official menu places.
export const DESK_VERSION = '0.2.0';
export const OFFICIAL_PLACES = ['chat', 'research', 'tasks', 'sales', 'files', 'agents', 'models', 'settings'];
export const DESK_MODULES = ['accounts', 'agents', 'apis', 'backup', 'bench', 'browser', 'calendar', 'channels', 'chat', 'code', 'connect', 'council', 'doctor', 'files', 'finder', 'flows', 'life', 'looks', 'mail', 'meetings', 'memory', 'models', 'network', 'office', 'payments', 'playbooks', 'research', 'safety', 'sales', 'scorecard', 'search', 'social', 'store', 'studio', 'tables', 'tasks', 'vault', 'voice'];
export const DESK_NUMBERS = [...Array.from({ length: 32 }, (_, i) => i + 1), 34, 35, 38, 39, 40, 41];
/** The desk keeps an owner's own skill to these sizes (modules/agents/server.js, addSkill). */
export const SKILL_LIMITS = { title: 80, body: 4000, description: 160 };
/** Quiet the one warning Node prints when node:sqlite loads, so reports stay readable. Other warnings still print. */
export function quietSqliteWarning() {
  process.removeAllListeners('warning');
  process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w.name + ': ' + w.message); });
}
