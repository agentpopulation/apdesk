// App settings: one table, defaults here. Security level and auto-approve are owned by approval-door.js and only
// written through core/settings-routes.js. Everything else is plain.
export const DEFAULTS = Object.freeze({
  theme: 'light',                 // 'light' | 'dark'
  role: null,                     // onboarding: 'sales' | 'entrepreneur' | 'host' | 'educator' | 'student' | null (everything)
  onboarded: false,
  online: true,
  ownerName: '',
  appName: 'AP Desk',   // shown in the top bar and the window title; the owner may rename the desk
  companyName: '',                    // the owner's business, for agents that write in its name
  notifications: true,                // tell the owner when a job finishes: notice, menu badge, desktop notification
  country: 'IN', currency: 'INR', timeZone: 'Asia/Kolkata', locale: 'en-IN',
  'router.enabled': true, 'router.baseUrl': 'http://127.0.0.1:8787/v1', 'router.freeOnly': true, 'router.builtin': true,
  'ollama.baseUrl': 'http://127.0.0.1:11434',
  'model.defaultChain': ['router', 'ollama', 'keyed'],
  'openrouter.allowPaid': false,     // free OpenRouter models only unless the owner switches this on (guarded route)
  'spend.perItem': 200000, 'spend.perDay': 500000, 'spend.perMonth': 2000000,   // minor units (paise)
  'security.level': 'open',       // read here, written only by approval-door via settings-routes
  'security.autoApproveUntil': null,
  'files.allowedFolders': [],
  'network.lanNodes': [],
});

export class Settings {
  constructor(storage) { this.s = storage; this.listeners = new Set(); }
  get(key) {
    const r = this.s.get('SELECT value FROM settings WHERE key = ?', key);
    if (!r) return DEFAULTS[key];
    try { return JSON.parse(r.value); } catch { return DEFAULTS[key]; }
  }
  all() {
    const out = { ...DEFAULTS };
    for (const r of this.s.all('SELECT key, value FROM settings')) { try { out[r.key] = JSON.parse(r.value); } catch {} }
    return out;
  }
  set(key, value) {
    this.s.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value ?? null));
    for (const fn of this.listeners) { try { fn(key, value); } catch {} }
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  /** Read-only view handed to modules. */
  readonly() { return { get: (k) => this.get(k), all: () => this.all(), onChange: (fn) => this.onChange(fn) }; }
}
