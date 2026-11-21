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
  'business.about': '',               // what he sells, who buys it and where, in his own words (up to 600 characters)
  notifications: true,                // tell the owner when a job finishes: notice, menu badge, desktop notification
  // country, currency, timeZone and locale: taken from this computer on a fresh desk (systemPlace below), never assumed
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

const PLACE_KEYS = ['country', 'currency', 'timeZone', 'locale'];
/** What a desk showed before these came from the computer. A desk that was set up then keeps exactly these. */
const EARLIER_PLACE = Object.freeze({ country: 'IN', currency: 'INR', timeZone: 'Asia/Kolkata', locale: 'en-IN' });
/** Common countries only; any other country gets USD until the owner changes it in Settings › General. */
const CURRENCY = { IN: 'INR', US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', IE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR', FI: 'EUR', GR: 'EUR', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', JP: 'JPY', CN: 'CNY', SG: 'SGD', MY: 'MYR', ID: 'IDR', PH: 'PHP', AE: 'AED', SA: 'SAR', PK: 'PKR', BD: 'BDT', LK: 'LKR', NP: 'NPR', ZA: 'ZAR', NG: 'NGN', KE: 'KES', BR: 'BRL', MX: 'MXN' };

/** Where this computer says it is: its time zone and locale, the locale's country and that country's currency.
 *  system: { timeZone, locale, env } for tests; by default Intl and the process environment. */
export function systemPlace(system = {}) {
  let o = {}; try { o = Intl.DateTimeFormat().resolvedOptions(); } catch {}
  const env = system.env || process.env;
  let locale = system.locale || o.locale || 'en-US';
  // Intl falls back to en-US when it finds nothing; on Unix the environment may still name the owner's locale
  const fromEnv = String(env.LC_ALL || env.LC_MESSAGES || env.LANG || '').replace(/\..*$/, '').replace('_', '-');
  if (!system.locale && locale === 'en-US' && /^[a-z]{2,3}-[A-Z]{2}$/.test(fromEnv)) locale = fromEnv;
  let country = '';
  try { const l = new Intl.Locale(locale); country = l.region || l.maximize().region || ''; } catch {}
  return { country: country || 'US', currency: CURRENCY[country] || 'USD', timeZone: system.timeZone || o.timeZone || 'UTC', locale };
}

// Kept by the house for every space (contracts/PEOPLE.md): a space other than the main one reads these from the house's
// settings and cannot write them. Online and offline is one switch for the whole desk.
const HOUSE_KEYS = new Set(['online']);

export class Settings {
  constructor(storage, { system, house = null } = {}) {
    this.s = storage; this.listeners = new Set(); this.house = house;
    this.defaults = { ...DEFAULTS, ...systemPlace(system) };
    // a desk that was already set up keeps what it showed before: the earlier values are stored for it, once
    if (this.stored('onboarded')) for (const k of PLACE_KEYS) if (!this.stored(k)) this.set(k, EARLIER_PLACE[k]);
  }
  stored(key) { if (this.house && HOUSE_KEYS.has(key)) return this.house.stored(key); return !!this.s.get('SELECT 1 AS x FROM settings WHERE key = ?', key); }
  get(key) {
    if (this.house && HOUSE_KEYS.has(key)) return this.house.get(key);
    const r = this.s.get('SELECT value FROM settings WHERE key = ?', key);
    if (!r) return this.defaults[key];
    try { return JSON.parse(r.value); } catch { return this.defaults[key]; }
  }
  all() {
    const out = { ...this.defaults };
    for (const r of this.s.all('SELECT key, value FROM settings')) { try { out[r.key] = JSON.parse(r.value); } catch {} }
    if (this.house) for (const k of HOUSE_KEYS) out[k] = this.house.get(k);
    return out;
  }
  set(key, value) {
    if (this.house && HOUSE_KEYS.has(key)) throw Object.assign(new Error('Online and offline are set for the whole desk.'), { code: 'forbidden' });
    this.s.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value ?? null));
    for (const fn of this.listeners) { try { fn(key, value); } catch {} }
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  /** Read-only view handed to modules. */
  readonly() { return { get: (k) => this.get(k), all: () => this.all(), onChange: (fn) => this.onChange(fn), setOwnerText: (k, v) => this.setOwnerText(k, v) }; }
  /** The one write a module may make: text the owner typed about his business, when he answers the desk's question in a chat.
   *  Only this key, only text, capped. Nothing here can change security, spend or tools. */
  setOwnerText(key, value) {
    if (key !== 'business.about') throw new Error('Only the owner\'s business text can be saved this way.');
    const v = String(value ?? '').trim().slice(0, 600); this.set(key, v); return v;
  }
}
