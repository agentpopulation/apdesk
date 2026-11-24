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
  'router.enabled': true, 'router.baseUrl': 'http://127.0.0.1:8787/v1', 'router.builtin': true,
  'ollama.baseUrl': 'http://127.0.0.1:11434',
  'model.defaultChain': ['router', 'ollama', 'keyed'],
  'openrouter.allowPaid': false,     // free OpenRouter models only unless the owner switches this on (guarded route)
  // spend.perItem, spend.perDay, spend.perMonth: in hundredths of the currency's main unit; when the owner has set none,
  // the usual amounts for his currency (spendDefaults below)
  'security.level': 'open',       // read here, written only by approval-door via settings-routes
  'security.autoApproveUntil': null,
  'files.allowedFolders': [],
  'network.lanNodes': [],
});

const PLACE_KEYS = ['country', 'currency', 'timeZone', 'locale'];
/** What a desk showed before these came from the computer. A desk that was set up then keeps exactly these. */
const EARLIER_PLACE = Object.freeze({ country: 'IN', currency: 'INR', timeZone: 'Asia/Kolkata', locale: 'en-IN' });
/** Set once a desk has been opened by this version: from then on, a stored 'onboarded' never means "an earlier desk". */
const PLACE_CHECKED = 'place.checked';
/** When the place first came from the computer. A desk whose first records are older was made by a build that showed India. */
const PLACE_FROM_COMPUTER = '2026-11-20T12:08:00.000Z';
function madeBefore(s, iso) {
  let first = null;
  for (const sql of ['SELECT MIN(created) AS t FROM agents', 'SELECT MIN(at) AS t FROM activity', 'SELECT MIN(created) AS t FROM approvals', 'SELECT MIN(created) AS t FROM jobs']) {
    try { const t = s.get(sql)?.t; if (t && (!first || t < first)) first = t; } catch {}
  }
  return !!first && first < iso;
}
/** The usual currency of a country. Any other country gets USD on a fresh desk; first start shows it and asks "Is this right?". */
const CURRENCY = { IN: 'INR', US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', IE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR', FI: 'EUR', GR: 'EUR', LU: 'EUR', SK: 'EUR', SI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', MT: 'EUR', CY: 'EUR', HR: 'EUR',
  CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', IS: 'ISK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON', BG: 'BGN', RS: 'RSD', UA: 'UAH', RU: 'RUB', BY: 'BYN', TR: 'TRY', IL: 'ILS',
  JP: 'JPY', CN: 'CNY', HK: 'HKD', TW: 'TWD', KR: 'KRW', SG: 'SGD', MY: 'MYR', ID: 'IDR', PH: 'PHP', TH: 'THB', VN: 'VND', KH: 'KHR', MM: 'MMK', KZ: 'KZT', UZ: 'UZS',
  AE: 'AED', SA: 'SAR', QA: 'QAR', KW: 'KWD', BH: 'BHD', OM: 'OMR', JO: 'JOD', EG: 'EGP', MA: 'MAD', DZ: 'DZD', TN: 'TND', PK: 'PKR', BD: 'BDT', LK: 'LKR', NP: 'NPR',
  ZA: 'ZAR', NG: 'NGN', KE: 'KES', GH: 'GHS', TZ: 'TZS', UG: 'UGX', ET: 'ETB', BR: 'BRL', MX: 'MXN', AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN', UY: 'UYU', EC: 'USD', PR: 'USD', DO: 'DOP', CR: 'CRC', GT: 'GTQ' };

/** Where this computer says it is: its time zone and locale, the locale's country and that country's currency.
 *  system: { timeZone, locale, env } for tests; by default Intl and the process environment. */
export function systemPlace(system = {}) {
  let o = {}; try { o = Intl.DateTimeFormat().resolvedOptions(); } catch {}
  const env = system.env || process.env;
  let locale = system.locale || o.locale || 'en-US';
  // Intl falls back to en-US when it finds nothing; on Unix the environment may still name the owner's locale
  const fromEnv = String(env.LC_ALL || env.LC_MESSAGES || env.LANG || '').replace(/\..*$/, '').replace('_', '-');
  if (!system.locale && locale === 'en-US' && /^[a-z]{2,3}-[A-Z]{2}$/.test(fromEnv)) locale = fromEnv;
  if (!checkPlace('locale', locale).ok) locale = 'en-US';
  let country = '';
  try { const l = new Intl.Locale(locale); country = l.region || l.maximize().region || ''; } catch {}
  let timeZone = system.timeZone || o.timeZone || 'UTC';
  if (!checkPlace('timeZone', timeZone).ok) timeZone = 'UTC';
  return { country: country || 'US', currency: CURRENCY[country] || 'USD', timeZone, locale };
}

// Not countries, though Intl gives them a name
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ']);
let regionNames = null;
const regionName = (code) => { try { regionNames ||= new Intl.DisplayNames(['en'], { type: 'region' }); const n = regionNames.of(code); return n && n !== code && n !== 'Unknown Region' ? n : null; } catch { return null; } };
/** Is this a country, currency, time zone or number and date style the computer can use? { ok, value } with the value in
 *  its usual spelling, or { ok: false, reason } in plain words. Times and money are drawn with these on every screen, so
 *  nothing else is ever stored for them. */
export function checkPlace(key, raw) {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (key === 'timeZone') {
    try { if (v) { new Intl.DateTimeFormat('en-US', { timeZone: v }); return { ok: true, value: v }; } } catch {}
    return { ok: false, reason: 'That is not a time zone this computer knows. Pick one from the list.' };
  }
  if (key === 'locale') {
    try { const c = Intl.getCanonicalLocales(v)[0]; if (c && Intl.DateTimeFormat.supportedLocalesOf(c).length && Intl.NumberFormat.supportedLocalesOf(c).length) return { ok: true, value: c }; } catch {}
    return { ok: false, reason: 'That is not a number and date style this computer knows. Pick one from the list.' };
  }
  if (key === 'currency') {
    const c = v.toUpperCase();
    if (/^[A-Z]{3}$/.test(c) && Intl.supportedValuesOf('currency').includes(c)) return { ok: true, value: c };
    return { ok: false, reason: 'That is not a currency this computer knows. Pick one from the list.' };
  }
  if (key === 'country') {
    const c = v.toUpperCase();
    if (/^[A-Z]{2}$/.test(c) && !NOT_COUNTRIES.has(c) && regionName(c)) return { ok: true, value: c };
    return { ok: false, reason: 'That is not a country this computer knows. Pick one from the list.' };
  }
  return { ok: true, value: raw };
}

// Spend limits an agent may use without asking (once Payments is on), per item, day and month, in the currency's main
// unit. Round amounts of about the same worth. A currency not listed has no usual amounts: every spend then asks the owner
// and paid model calls are off until he sets his own limits (Settings › Payments and spend). Stored limits are always hundredths of the main unit.
const SPEND_USUAL = {
  INR: [2000, 5000, 20000], USD: [25, 50, 200], EUR: [25, 50, 200], GBP: [20, 50, 200], CHF: [25, 50, 200], CAD: [30, 75, 250], AUD: [40, 80, 300], NZD: [40, 80, 300],
  JPY: [3000, 8000, 30000], CNY: [200, 400, 1500], HKD: [200, 400, 1500], SGD: [30, 75, 250], KRW: [30000, 70000, 250000], SEK: [300, 600, 2000], NOK: [300, 600, 2000], DKK: [200, 400, 1500],
  PLN: [100, 200, 800], BRL: [150, 300, 1000], MXN: [500, 1000, 4000], ZAR: [500, 1000, 4000], AED: [100, 200, 750],
};
export const SPEND_KEYS = ['spend.perItem', 'spend.perDay', 'spend.perMonth'];
/** The usual limits for a currency, in hundredths of its main unit; all 0 (every spend asks, paid model calls off) for one with no usual amounts. */
export function spendDefaults(currency) {
  const u = SPEND_USUAL[String(currency || '').toUpperCase()] || [0, 0, 0];
  return Object.fromEntries(SPEND_KEYS.map((k, i) => [k, u[i] * 100]));
}

// Kept by the house for every space (contracts/PEOPLE.md): a space other than the main one reads these from the house's
// settings and cannot write them. Online and offline is one switch for the whole desk; the local model addresses (Ollama,
// the model boxes on the owner's network) are what Offline still lets through, so they are the keeper's alone too.
const HOUSE_KEYS = new Set(['online', 'ollama.baseUrl', 'network.lanNodes']);
const PLACE_WORDS = { country: 'country', currency: 'currency', timeZone: 'time zone', locale: 'number and date style' };


export class Settings {
  constructor(storage, { system, house = null } = {}) {
    this.s = storage; this.listeners = new Set(); this.house = house;
    this.defaults = { ...DEFAULTS, ...systemPlace(system) };
    // once, on the first start of this version: a desk made before the place came from the computer showed India, and
    // keeps it. Any later desk keeps the computer's own; if the one-time step of the version before wrote India over it
    // (all at once, while this computer is not in India), that write is undone and the owner is told.
    if (!this.stored(PLACE_CHECKED)) {
      if (madeBefore(this.s, PLACE_FROM_COMPUTER)) { for (const k of PLACE_KEYS) if (!this.stored(k)) this.set(k, EARLIER_PLACE[k]); }
      else {
        const here = this.defaults, inIndia = here.country === 'IN' || /^Asia\/(Kolkata|Calcutta)$/.test(here.timeZone);
        const rows = inIndia ? [] : PLACE_KEYS.map(k => ({ k, r: this.s.get('SELECT rowid AS id, value FROM settings WHERE key = ?', k) })).filter(x => x.r && x.r.value === JSON.stringify(EARLIER_PLACE[x.k]));
        const together = rows.length >= 3 && ['country', 'currency', 'locale'].every(k => rows.some(x => x.k === k)) && rows.every((x, i) => i === 0 || x.r.id === rows[i - 1].r.id + 1);
        if (together) {
          for (const x of rows) this.s.run('DELETE FROM settings WHERE key = ?', x.k);
          this.set('ui.placeNotice', `Your country, currency and time zone follow this computer again: ${regionName(this.get('country')) || this.get('country')}, ${this.get('currency')}, ${this.get('timeZone')}. You can change them in Settings › General.`);
        }
      }
      this.set(PLACE_CHECKED, true);
    }
    // a stored value the computer cannot use (typed by hand before Settings offered choices) would break every time and
    // amount on screen: it goes, the computer's own is used, and the owner is told once (the shell shows 'ui.placeNotice')
    const healed = [];
    for (const k of PLACE_KEYS) if (this.stored(k) && !checkPlace(k, this.get(k)).ok) { this.s.run('DELETE FROM settings WHERE key = ?', k); healed.push(k); }
    if (healed.length) this.set('ui.placeNotice', `Your ${healed.map(k => PLACE_WORDS[k]).join(' and ')} ${healed.length > 1 ? 'were' : 'was'} not one this computer knows, so the desk uses this computer's own: ${healed.map(k => this.get(k)).join(', ')}. You can change it in Settings › General.`);
  }
  /** True for a key only the main space (the keeper's desk) may write: another space reads the house's value. */
  isHouseKey(key) { return !!this.house && HOUSE_KEYS.has(key); }
  stored(key) { if (this.house && HOUSE_KEYS.has(key)) return this.house.stored(key); return !!this.s.get('SELECT 1 AS x FROM settings WHERE key = ?', key); }
  /** The number and date style when the owner has set none: the default style's language in the country he chose (en-IN
   *  for India groups 12,34,567), if this computer knows it; else the default. */
  localeDefault() {
    if (!this.stored('country')) return this.defaults.locale;
    try { const v = checkPlace('locale', `${new Intl.Locale(this.defaults.locale).language}-${this.get('country')}`); if (v.ok) return v.value; } catch {}
    return this.defaults.locale;
  }
  get(key) {
    if (this.house && HOUSE_KEYS.has(key)) return this.house.get(key);
    const r = this.s.get('SELECT value FROM settings WHERE key = ?', key);
    if (!r && key === 'locale') return this.localeDefault();
    if (!r) return SPEND_KEYS.includes(key) ? spendDefaults(this.get('currency'))[key] : this.defaults[key];
    try { return JSON.parse(r.value); } catch { return this.defaults[key]; }
  }
  all() {
    const out = { ...this.defaults, locale: this.localeDefault() };
    for (const r of this.s.all('SELECT key, value FROM settings')) { try { out[r.key] = JSON.parse(r.value); } catch {} }
    if (this.house) for (const k of HOUSE_KEYS) out[k] = this.house.get(k);
    for (const k of SPEND_KEYS) if (!(k in out)) out[k] = this.get(k);
    return out;
  }
  set(key, value) {
    if (this.house && HOUSE_KEYS.has(key)) throw Object.assign(new Error(key === 'online' ? 'Online and offline are set for the whole desk.' : 'The local model addresses are set for the whole PC, on the Admin\'s own desk.'), { code: 'forbidden' });
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
