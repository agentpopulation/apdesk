// Every module of the desk, by number. Used by the Module Store to show modules whose folder is not in this build,
// and checked by store.test.js against the module folders, so a new module cannot be left out.
export const CATALOG = [
  [1, 'chat', 'Chat and Coordinator', 'core'], [2, 'models', 'Models and Router', 'core'], [3, 'search', 'Search', 'core'],
  [4, 'research', 'Research', 'core'], [5, 'browser', 'Browser and Computer', 'core'], [6, 'files', 'Files and Knowledge', 'core'],
  [7, 'office', 'Office', 'core'], [8, 'agents', 'Agents and Skills', 'core'], [9, 'memory', 'Memory, Dream and Learn', 'core'],
  [10, 'council', 'Council', 'core'], [11, 'tasks', 'Tasks', 'core'], [12, 'flows', 'Flows and Schedules', 'core'],
  [13, 'sales', 'Sales CRM', 'core'], [14, 'safety', 'Safety', 'core'], [15, 'backup', 'Backup', 'core'], [16, 'store', 'Module Store', 'core'],
  [17, 'mail', 'Mail', 'switch-on'], [18, 'calendar', 'Calendar', 'switch-on'], [19, 'social', 'Social', 'switch-on'],
  [20, 'channels', 'Channels', 'switch-on'], [21, 'voice', 'Voice', 'switch-on'], [22, 'vault', 'Vault and Logins', 'switch-on'],
  [23, 'accounts', 'Accounts and Lock', 'switch-on'], [24, 'payments', 'Payments and Spend', 'switch-on'], [25, 'code', 'Code and Sandbox', 'switch-on'],
  [26, 'connect', 'Connect (MCP)', 'switch-on'], [27, 'network', 'Network and OSINT', 'switch-on'], [28, 'life', 'Life', 'switch-on'],
  [29, 'studio', 'Studio', 'switch-on'], [30, 'looks', 'Looks', 'parked'],
  [31, 'bench', 'Bench', 'switch-on'], [32, 'finder', 'Finder', 'switch-on'], [34, 'apis', 'APIs', 'switch-on'],
  [35, 'tables', 'Tables', 'switch-on'], [38, 'doctor', 'Doctor', 'switch-on'],
].map(([number, id, name, kind]) => ({ number, id, name, kind }));

export const GROUPS = [
  ['core', 'On from the first run', 'Part of the desk. They start with it and stay on.'],
  ['switch-on', 'Switch on when you want them', 'Off until you switch them on. Switching off hides their places and settings; what they saved stays.'],
  ['parked', 'Parked', 'Not built in this version.'],
];

/** Merge what the desk reports (GET /api/modules) with the catalog: every catalog number appears once. */
export function merge(live) {
  const byId = new Map(live.map(m => [m.id, m]));
  const out = CATALOG.map(c => { const m = byId.get(c.id); byId.delete(c.id); return m ? { ...m, kind: m.kind || c.kind, installed: true } : { ...c, installed: false, on: false, menu: [], settings: [], agentTabs: [], tools: [], requires: [], attribution: [] }; });
  for (const m of byId.values()) out.push({ ...m, installed: true });     // anything not in the catalog (a test fixture)
  return out.sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
}
