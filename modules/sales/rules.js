// Lead quality rules: the host classes (news, directory, marketplace, document, data hosts), "not a company" words, and the buyer-versus-seller
// filter. Pure functions, no I/O.

const MARKETPLACES = /(^|\.)(indiamart|justdial|tradeindia|exportersindia|sulekha|yellowpages|alibaba|made-in-china|go4worldbusiness|tradekey|indianyellowpages|asklaila|getit|grotal|nearbuy|magicpin|udaan|moglix|industrybuying)\./;
const DOC_HOSTS = /(^|\.)(scribd|slideshare|issuu|docplayer|pdfcoffee|yumpu|academia|researchgate|studocu|coursehero|dokumen|documents|vdocuments|fliphtml5|calameo|anyflip|1library|pdfslide)\./;
const DATA_HOSTS = /(^|\.)(zaubacorp|tofler|thecompanycheck|falconebiz|instafinancials|opencorporates|corporatedir|companydetails|crunchbase|owler|zoominfo|dnb|kompass|apollo|rocketreach|signalhire|leadiq|lusha|ambitionbox|glassdoor|naukri|indeed|monster|foundit|linkedin|facebook|instagram|twitter|x|youtube|quora|reddit|medium|pinterest|amazon|flipkart|clutch|goodfirms|g2|capterra|yelp|tripadvisor|tracxn|bizapedia|marketscreener)\./;
const NEWS_HOSTS = /(news|times|thehindu|livemint|business-standard|moneycontrol|inc42|yourstory|ndtv|reuters|bloomberg|forbes|cnbc|bbc|cnn|theguardian|ft\.com|wsj|economist|indiatoday|financialexpress|businessline|deccanherald|firstpost|scroll\.in|thewire|businessinsider|techcrunch|prnewswire|businesswire|globenewswire|newindianexpress|indianexpress|hindustantimes)/;
const NOT_A_COMPANY = /\b(industrial (?:area|estate|park|cluster|zone|corridor|township)|industries association|association of|chamber of|federation of|confederation|special economic zone|ministry of|department of|government of|university|institute of technology)\b/i;

export function hostOf(url) { try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\d?\./, ''); } catch { return ''; } }

/** What a page's host is, from its address alone: 'marketplace' | 'document' | 'aggregator' | 'news' | 'encyclopedia' | null. */
export function hostKind(url) {
  const host = hostOf(url);
  if (!host) return null;
  if (/(^|\.)wikipedia\.org$/.test(host)) return 'encyclopedia';
  if (MARKETPLACES.test(host + '.')) return 'marketplace';
  if (DOC_HOSTS.test(host + '.')) return 'document';
  if (DATA_HOSTS.test(host + '.')) return 'aggregator';
  if (NEWS_HOSTS.test(host)) return 'news';
  return null;
}
/** Pages we never read for leads: shops, data brokers and social sites (their text is a login wall or a list of sellers). */
export const skipSource = (url) => ['marketplace', 'aggregator', 'document'].includes(hostKind(url)) || /\.(pdf|docx?|xlsx?|pptx?)(\?|#|$)/i.test(String(url));
export const notACompany = (name) => NOT_A_COMPANY.test(String(name || ''));

/** The publisher of a news site, directory or shop is not itself a lead: "The Harbour Times" from harbourtimes.example. */
export function isPublisher(name, url) {
  const kind = hostKind(url); if (!kind) return false;
  const slug = normName(name).replace(/\s+/g, '');
  const host = hostOf(url).split('.')[0];
  return !!slug && (host.includes(slug) || slug.includes(host)) && kind !== 'encyclopedia';
}

// ---- buyer versus seller (buyer-intent.js)
const SELLER_NOUN = '(?:manufacturers?|makers?|suppliers?|dealers?|distributors?|wholesalers?|retailers?|exporters?|importers?|traders?|stockists?|vendors?|sellers?|resellers?|shops?|stores?|brands?|producers?|factory|factories)';
const SELLER_VERB = '(?:manufactur(?:e|es|ing|er of)|suppl(?:y|ies|ying|ier of)|deal(?:s|ing)?\\s+in|distribut(?:e|es|ing|or of)|export(?:s|ing|er of)|sell(?:s|ing)?|wholesale)';
const SHOP_WORDS = /\b(?:buy\s+(?:online|now)|add\s+to\s+cart|price\s+list|best\s+price|for\s+sale|get\s+(?:a\s+)?quote|request\s+(?:a\s+)?quote|in\s+stock|moq|per\s+(?:kg|bag|piece|unit))\b/i;
const STOP = new Set(['and', 'the', 'for', 'of', 'in', 'with', 'top', 'best', 'bulk']);
export function productWords(product) {
  return String(product || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w));
}
/** True when this text presents itself as a seller of the product (so it is no buyer lead). */
export function looksLikeSeller(text, product) {
  const words = productWords(product);
  const hay = String(text || '').toLowerCase();
  if (!words.length || !words.every((w) => hay.includes(w))) return false;
  const p = words.map((w) => `${w}s?`).join('[\\s-]+');
  if (new RegExp(`\\b${p}\\s+${SELLER_NOUN}\\b`, 'i').test(hay)) return true;
  if (new RegExp(`\\b${SELLER_NOUN}\\s+(?:of|for)\\s+(?:\\w+\\s+){0,3}?${p}\\b`, 'i').test(hay)) return true;
  if (new RegExp(`\\b${SELLER_VERB}\\s+(?:\\w+\\s+){0,4}?${p}\\b`, 'i').test(hay)) return true;
  return SHOP_WORDS.test(hay);
}
/** "buyers of tile adhesive", "companies that use X", "who need X": the ask wants buyers, not makers. Returns the product or null. */
export function buyerAsk(query) {
  const q = String(query || '');
  const m = q.match(/\b(?:buyers?|users?|customers?)\s+(?:of|for)\s+(.+?)(?:\s+in\s+[A-Z][\w\s]+)?(?:,|\.|$| with\b)/i) || q.match(/\b(?:that|who|which)\s+(?:buy|use|need|purchase)\s+(.+?)(?:\s+in\s+[A-Z][\w\s]+)?(?:,|\.|$| with\b)/i);
  return m ? m[1].trim() : null;
}

// ---- names
const LEGAL = /\b(private limited|pvt\.? ltd\.?|pvt|ltd\.?|limited|llp|inc\.?|incorporated|corp\.?|corporation|co\.|company|plc|gmbh|ag|sa|s\.a\.)$/i;
export function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&amp;/g, '&').replace(/&/g, ' and ').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
/** The one same-name key for the pipeline (store) and the search (sameCompany): letters, marks and digits of every
 *  script, case, spaces and punctuation aside ("Quokka Payroll" = "QuokkaPayroll"; "शर्मा ट्रेडर्स" keeps its letters).
 *  "&" counts as "and", so "A&B Traders" = "A and B Traders" but not "AB Traders". */
export function nameKey(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&amp;/g, '&').replace(/&/g, 'and').replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}
/** Two names are the same by that key. An empty key never equals anything. */
export const sameNameKey = (a, b) => { const k = nameKey(a); return !!k && k === nameKey(b); };
export function coreName(s) { let n = String(s || '').replace(/\(.*?\)/g, '').trim(); for (let i = 0; i < 3; i++) n = n.replace(LEGAL, '').replace(/[,\s]+$/, '').trim(); return normName(n); }
/** The page text names the company (full name, or the name without Ltd / Pvt Ltd / Inc). */
export function textNames(text, name) {
  const t = ' ' + normName(text) + ' ';
  const full = normName(name); const core = coreName(name);
  if (full && t.includes(' ' + full + ' ')) return true;
  return !!core && core.length >= 3 && t.includes(' ' + core + ' ');
}
export function textHas(text, needle) { const n = normName(needle); return !!n && (' ' + normName(text) + ' ').includes(' ' + n + ' '); }
export function emailIn(text, email) { const e = String(email || '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e) && String(text || '').toLowerCase().includes(e); }

/** One key per company for de-duplication: "Kestrel India", "Kestrel Ltd." and "Kestrel" are the same lead;
 *  "T&K Industrial Automation (A member of Orion Group)" -> "t and k industrial automation". */
export function companyKey(s) {
  let n = String(s || '').replace(/\(.*?\)/g, ' ').replace(/[,\-–—]\s*(a\s+)?(member|part|subsidiary|division|unit)\s+of\b.*$/i, ' ').replace(/\b(a\s+)?(member|part|subsidiary|division)\s+of\s+.*$/i, ' ');
  n = normName(n);
  const TAIL = /\s+(india|indian|in india|pvt|private|ltd|limited|inc|incorporated|corp|corporation|co|company|gmbh|ag|plc|llp|llc|sa|bv|group)$/;
  for (let i = 0; i < 6 && TAIL.test(n); i++) n = n.replace(TAIL, '').trim();
  return n;
}
/** The part of a host that names a company: "new.kestrel.com" -> "kestrel", "orion.co.in" -> "orion". */
export function hostLabel(url) {
  const parts = hostOf(url).split('.'); if (parts.length < 2) return parts[0] || '';
  const sld = parts[parts.length - 2]; return (['co', 'com', 'net', 'org', 'ac', 'gov'].includes(sld) && parts.length >= 3) ? parts[parts.length - 3] : sld;
}
/** The site's host plausibly belongs to the company: a word of its name (4+ letters) or its initials are in the host label. */
export function siteMatches(company, url) {
  const label = hostLabel(url).replace(/[^a-z0-9]/g, ''); if (!label) return false;
  const words = companyKey(company).split(' ').filter(Boolean);
  if (words.some(w => w.length >= 4 && label.includes(w))) return true;
  const joined = words.join(''); if (joined.length >= 3 && (label === joined || label.startsWith(joined))) return true;
  const ini = words.map(w => w[0]).join(''); return ini.length >= 2 && (label === ini || label.startsWith(ini + 'india') || label === ini + 'group');
}
/** Mail addresses printed on a page, on the given domain first. */
const TLDS = new Set(('com net org edu gov int mil info biz io ai co app dev tech online site store shop global group cloud solutions software systems ' +
  'company business agency digital media works world email asia eu uk us in de fr it es nl be ch at se no dk fi pl pt ie jp cn hk sg my id th vn ph au nz ca mx br ar za ae sa qa kw om bh pk bd lk np').split(' '));
/** A mail address that ends at a real boundary with a known top-level domain, or '' ("sales@example.comwebsite" fails). */
export function strictEmail(e) {
  const m = String(e || '').trim().toLowerCase().match(/^[a-z0-9._%+-]{1,64}@([a-z0-9-]{1,63}\.)+([a-z]{2,24})$/);
  if (!m) return '';
  const tld = m[2];
  return (TLDS.has(tld) || (tld.length === 2)) ? String(e).trim().toLowerCase() : '';
}
/** Mail addresses printed on a page: mailto: links first (when html is given), then text matches that end at a non-letter. */
export function emailsOn(text, preferHost = '', html = '') {
  const fromLinks = [...String(html || '').matchAll(/href\s*=\s*["']mailto:([^"'?#\s]+)/gi)].map(m => { try { return decodeURIComponent(m[1]); } catch { return m[1]; } });
  const plain = String(html ? String(html).replace(/<[^>]+>/g, ' ') + ' ' + text : text || '');
  const fromText = [...plain.matchAll(/(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,24})(?![A-Za-z0-9-])/g)].map(m => m[1]);
  const all = [...new Set([...fromLinks, ...fromText].map(strictEmail).filter(Boolean))].filter(e => !/\.(png|jpe?g|gif|webp|svg)$/.test(e) && !/example\.|sentry|wixpress|domain\.com/.test(e) && !/^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|bounce)/.test(e));
  const dom = hostLabel('https://' + preferHost);
  const link = new Set(fromLinks.map(x => x.toLowerCase()));
  return all.sort((a, b) => ((link.has(b) ? 2 : 0) + (b.includes(dom) ? 1 : 0)) - ((link.has(a) ? 2 : 0) + (a.includes(dom) ? 1 : 0)));
}
const GENERIC_FIELD = new Set(['hr', 'payroll', 'software', 'technologies', 'technology', 'tech', 'systems', 'system', 'solutions', 'solution', 'india', 'services', 'labs', 'automation', 'infotech', 'digital', 'online', 'app', 'apps', 'cloud', 'global']);
const STOPWORDS = new Set(['find', 'companies', 'company', 'with', 'sources', 'source', 'that', 'which', 'make', 'makes', 'making', 'selling', 'sell', 'sells', 'small', 'large', 'medium', 'businesses', 'business', 'india', 'indian', 'leads', 'lead', 'their', 'from', 'into', 'about', 'provides', 'provider', 'offers', 'offering', 'leading', 'other', 'like', 'also', 'more', 'have', 'this', 'these', 'those', 'were', 'they', 'them', 'such', 'based', 'software', 'solutions', 'services', 'products', 'product', 'systems', 'technology', 'technologies', 'platform', 'platforms', 'equipment', 'firms', 'firm', 'manufacturer', 'manufacturers', 'suppliers', 'supplier', 'list', 'top', 'best', 'well', 'known']);
/** Distinctive words of an ask or a need: "HR or payroll software for small businesses" -> ["hr", "payroll"]. Acronyms count. */
export function topicWords(...texts) {
  const out = new Set();
  for (const t of texts) for (const w of normName(t).split(' ')) if (w && !STOPWORDS.has(w) && !/^\d+$/.test(w) && (w.length >= 4 || /^[a-z]{2,3}$/.test(w) && String(t).match(new RegExp(`\\b${w.toUpperCase()}\\b`)))) out.add(w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);
  return [...out];
}
/** How often a field word occurs on a page as a whole word. "payroll" counts "payrolls"; "hr" counts "hrms" and "hris" but never "hrs" (hours). */
export function fieldHits(text, word) {
  const w = String(word).toLowerCase(); let n = 0;
  for (const tok of normName(text).split(' ')) {
    if (tok === w) n++;
    else if (w.length <= 3) { if (tok.startsWith(w) && tok.length <= w.length + 2 && tok !== w + 's') n++; }
    else if (tok === w + 's' || tok === w + 'es') n++;
  }
  return n;
}
/**
 * The page is about the same kind of business as the ask: the ask's field words (not words of the lead's need line) are in
 * the page's title, its opening lines (main heading, description) or come up several times in the main text. One stray
 * mention (a careers line, a footer, a customer list) is not enough: a broadband site that says "payroll" once is refused.
 * Returns { ok, why }.
 */
export function aboutSameBusiness(page, fieldWords) {
  const words = [...new Set(fieldWords)].filter(Boolean);
  if (!words.length) return { ok: true, why: 'the ask names no field words' };
  const title = String(page?.title || ''); const text = String(page?.text || ''); const head = text.slice(0, 300);
  const inTitle = words.filter(w => fieldHits(title, w) > 0); if (inTitle.length) return { ok: true, why: `"${inTitle[0]}" is in the title` };
  const inHead = words.filter(w => fieldHits(head, w) > 0); if (inHead.length) return { ok: true, why: `"${inHead[0]}" is in the opening lines` };
  const total = words.reduce((a, w) => a + fieldHits(text, w), 0);
  return total >= 3 ? { ok: true, why: `field words come up ${total} times in the text` } : { ok: false, why: total ? `field words come up only ${total} time${total === 1 ? '' : 's'}, in passing` : 'none of the field words is on the page' };
}
/** Kept for callers that pass plain text: the same rule on text alone. */
export function sameBusiness(pageText, topics) { return aboutSameBusiness({ title: '', text: pageText }, topics).ok; }

// ---- what a company sells. When the ask names a kind of product (software), a lead fits only when a page that was read says
// that this company sells it: a field word of the ask next to a word of that kind ("payroll software", "HR platform", "HRMS"),
// in words about the company itself. The company's own name never counts ("Ciel HR" says nothing about software), a list's
// heading never counts for the names under it, and a company whose own words name another kind of business (staffing,
// recruitment, consulting, IT services) is that business.
const KINDS = [{ ask: /\b(software|saas|apps?|platforms?|hrms|hris|erp|crm)\b/i, word: /^(software|softwares|saas|app|apps|platform|platforms|hrms|hris|erp|crm|tool|tools|system|systems|suite|module|modules)$/ }];
const OTHER_KIND = /\b(staffing|recruitment|recruiting|recruiters?|manpower|placements?|head-?hunt\w*|executive search|it services|it consulting|consultancy|consultants?|consulting|outsourcing|bpo|software development|web development|it solutions)\b/i;
const DOING = new Set(('is are was offers offer provides provide sells sell builds build makes make develops develop runs run helps help delivers deliver ' +
  'automates automate simplifies simplify powers power specialises specializes focuses creates create brings bring has have').split(' '));
const SEP = new Set([':', '-', '–', '—', '|', '(']);
const MARK = '\u0001';
/** The ask's kind of product, or null when it names none (then fit is left to the field words, as before). */
export function askKind(query) { return KINDS.find(k => k.ask.test(String(query || ''))) || null; }
/** The text with the company's name (full and without generic field words) replaced by a marker. */
function withoutName(text, company, askWords = []) {
  const drop = new Set([...GENERIC_FIELD, ...askWords]);
  const full = String(company || '').replace(/\(.*?\)/g, ' ').split(/[^\p{L}\p{N}&]+/u).filter(Boolean);
  const core = companyKey(company).split(' ').filter(w => w && !drop.has(w) && !drop.has(w.replace(/s$/, '')));
  let out = String(text || '');
  for (const words of [full, core]) if (words.length && words.join('').length >= 2) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${words.map(reEsc).join('[^\\p{L}\\p{N}]+')}(?![\\p{L}\\p{N}])`, 'giu'), ` ${MARK} `);
  return out;
}
const tokensOf = (s) => String(s || '').toLowerCase().match(new RegExp(`[\\p{L}\\p{N}]+|${MARK}|[:|(–—]|(?<=\\s)-(?=\\s)`, 'gu')) || [];
const fieldTok = (tok, field) => !field.length || field.some(w => fieldHits(tok, w) > 0);
/** One unit of text (a title, the opening lines or a sentence) says this company sells the ask's kind of product. own: the
 *  company's own page, where every line is its own; elsewhere the words must follow its name with a doing word ("X sells
 *  payroll software", "X, Y and Z sell HR software") or a separator ("X: HR software"). */
function unitSells(unit, company, field, kind, own) {
  const toks = tokensOf(withoutName(unit, company, field));
  const kinds = toks.map((t, i) => kind.word.test(t) || (/^hr(ms|is)$/.test(t)) ? i : -1).filter(i => i >= 0);
  for (const k of kinds) for (let f = Math.max(0, k - 4); f <= Math.min(toks.length - 1, k + 4); f++) {
    if (!fieldTok(toks[f], field) || toks[f] === MARK) continue;
    const e = Math.min(f, k);
    if (own) return true;
    const m = toks.lastIndexOf(MARK, e); if (m < 0) continue;
    if (e - m <= 25 && (toks.slice(m + 1, e).some(t => DOING.has(t)) || (SEP.has(toks[m + 1]) && e - m <= 15))) return true;
  }
  return false;
}
/** The words on a page that say this company sells the ask's kind of product, or ''. own: the page is the company's own site
 *  (its title, opening lines and every sentence count); otherwise only sentences that name the company. */
export function sellsIn(text, company, query, { own = false, title = '' } = {}) {
  const kind = askKind(query); if (!kind) return '';
  const field = topicWords(query);
  const units = own ? [title, String(text || '').slice(0, 300), ...sentencesOf(text)] : sentencesOf(text).filter(x => textNames(x, company));
  for (const u of units) if (u && u.length <= 400 && unitSells(u, company, field, kind, own)) return u.replace(/\s+/g, ' ').trim().slice(0, 200);
  return '';
}
/** The words that say the company is another kind of business than the ask names ("a recruitment and staffing company"), or ''.
 *  own: its site's title and opening lines; otherwise sentences that name it. A unit that also says it sells the asked kind is no clash. */
export function otherKindIn(text, company, query, { own = false, title = '' } = {}) {
  const kind = askKind(query); if (!kind) return '';
  const field = topicWords(query); const ask = String(query || '');
  const units = own ? [title, String(text || '').slice(0, 300)] : sentencesOf(text).filter(x => textNames(x, company) && x.length <= 400);
  const re = new RegExp(OTHER_KIND.source, 'gi');
  for (const u of units) {
    const bare = withoutName(u, company, field);
    for (const m of bare.matchAll(re)) {
      const next = tokensOf(bare.slice(m.index + m[0].length))[0] || '';
      if (kind.word.test(next) || new RegExp(`\\b${reEsc(m[1])}\\b`, 'i').test(ask)) continue;   // "recruitment software" is software
      if (!unitSells(u, company, field, kind, own)) return m[1].toLowerCase();
    }
  }
  return '';
}
/**
 * The one test of a candidate's own site, used by the search and by the real check: it names the company's business in the
 * ask's field (aboutSameBusiness, with the company's own name taken out of the title and text first), it does not describe
 * itself as another kind of business, and, when the ask names a kind of product, the words that say it sells it.
 * Returns { ok, why, sells, other }.
 */
export function siteFits(page, { query = '', company = '', need = '' } = {}) {
  const field = topicWords(query); const fieldOr = field.length ? field : topicWords(need);
  const title = String(page?.title || ''); const text = String(page?.text || '');
  const base = aboutSameBusiness({ title: withoutName(title, company, fieldOr).replaceAll(MARK, ' '), text: withoutName(text, company, fieldOr).replaceAll(MARK, ' ') }, fieldOr);
  const other = otherKindIn(text, company, query, { own: true, title });
  if (other) return { ok: false, why: `its own words say "${other}"`, sells: '', other };
  if (!base.ok) return { ok: false, why: base.why, sells: '', other: '' };
  if (!askKind(query)) return { ok: true, why: base.why, sells: '', other: '' };
  const sells = sellsIn(text, company, query, { own: true, title });
  return { ok: true, why: sells ? `it says "${sells.slice(0, 80)}"` : base.why, sells, other: '' };
}
/** "Kolam" and "Kolam HR" are one company: equal once generic words of the field (and of the ask) are dropped. */
export function sameCompany(a, b, askWords = []) {
  const ka = companyKey(a), kb = companyKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // the pipeline's own rule (store.findByName), the same function
  if (nameKey(a).length >= 3 && sameNameKey(a, b)) return true;
  if (ka.replace(/ /g, '').length >= 3 && ka.replace(/ /g, '') === kb.replace(/ /g, '')) return true;
  const drop = new Set([...GENERIC_FIELD, ...askWords]);
  const strip = (k) => k.split(' ').filter(w => !drop.has(w) && !drop.has(w.replace(/s$/, ''))).join(' ');
  const sa = strip(ka), sb = strip(kb);
  return sa.length >= 3 && sa === sb && (ka.startsWith(sa) && kb.startsWith(sb));
}
/** A sentence from a page that names the company (for findings: something true to say). */
export function sentenceNaming(text, company) {
  const sents = String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
  const hit = sents.find(x => x.length > 40 && x.length < 320 && textNames(x, company) && !/cookie|javascript|privacy|copyright|©|all rights/i.test(x));
  return hit || '';
}

/** The page names the company, by its full name or by its name without generic words of the field ("Kolam HR" -> "Kolam"). */
export function namesCompany(text, name, askWords = []) {
  if (textNames(text, name)) return true;
  const drop = new Set([...GENERIC_FIELD, ...askWords]);
  const core = companyKey(name).split(' ').filter(w => !drop.has(w) && !drop.has(w.replace(/s$/, ''))).join(' ');
  return core.length >= 3 && core !== companyKey(name) && textNames(text, core);
}

/** "https://www.nimbus.com/people" -> "nimbus.com"; "https://shop.acme.co.in" -> "acme.co.in". */
export function registrableDomain(url) {
  const parts = hostOf(url).split('.').filter(Boolean); if (parts.length <= 2) return parts.join('.');
  const sld = parts[parts.length - 2];
  return (['co', 'com', 'net', 'org', 'ac', 'gov'].includes(sld) && parts[parts.length - 1].length === 2) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
}
/**
 * Two leads are one seller to contact when their verified own sites sit on the same registrable domain, or when both
 * names start with the same distinctive brand word and at least one verified own site is on that brand's domain.
 * Shared list pages and data sites never count: only leads whose own site was checked (ownSite) are compared.
 * Also one seller by name alone, own site or not: the same brand word (3+ letters, not a field word or a word of the ask)
 * followed only by product or field words (PRODUCT_WORDS and the ask's own field words).
 */
const PRODUCT_WORDS = new Set(['people', 'payroll', 'hr', 'hrms', 'hris', 'books', 'suite', 'cloud', 'one', 'pro', 'software']);
export function sameSeller(a, b, askWords = []) {
  const da = a.ownSite && a.website ? registrableDomain(a.website) : '', db = b.ownSite && b.website ? registrableDomain(b.website) : '';
  if (da && db && da === db) return true;
  const words = (x) => companyKey(x.company).split(' ').filter(Boolean);
  const wa = words(a), wb = words(b); const ba = wa[0] || '', bb = wb[0] || '';
  const ask = new Set(askWords.map(w => String(w).toLowerCase()));
  if (!ba || ba !== bb || ba.length < 3 || GENERIC_FIELD.has(ba) || STOPWORDS.has(ba) || ask.has(ba)) return false;
  // by name alone: the rest of each name is only product or field words ("Nimbus People" and "Nimbus Payroll"), never a
  // distinctive word of its own ("Varma Consultancy" and "Varma Motors", "Kestrel India" and "Kestrel Healthcare")
  const product = (w) => PRODUCT_WORDS.has(w) || ask.has(w) || ask.has(w.replace(/s$/, ''));
  if (wa.slice(1).every(product) && wb.slice(1).every(product)) return true;
  return [da, db].some(d => d && hostLabel('https://' + d).replace(/[^a-z0-9]/g, '') === ba);
}

const COUNTRIES = { india: 'in', indian: 'in', germany: 'de', german: 'de', france: 'fr', french: 'fr', uk: 'uk', britain: 'uk', british: 'uk', 'united kingdom': 'uk', usa: 'us', 'united states': 'us', american: 'us', canada: 'ca', canadian: 'ca', australia: 'au', australian: 'au', japan: 'jp', japanese: 'jp', china: 'cn', chinese: 'cn', singapore: 'sg', uae: 'ae', dubai: 'ae', brazil: 'br', spain: 'es', spanish: 'es', italy: 'it', italian: 'it', netherlands: 'nl', dutch: 'nl', 'south africa': 'za', nepal: 'np', 'sri lanka': 'lk', bangladesh: 'bd', pakistan: 'pk', indonesia: 'id', malaysia: 'my', thailand: 'th', vietnam: 'vn', mexico: 'mx' };
const CC_TLDS = new Set(Object.values(COUNTRIES).concat(['ch', 'at', 'se', 'no', 'dk', 'fi', 'pl', 'pt', 'ie', 'be', 'ru', 'kr', 'tr', 'hk', 'nz', 'ar', 'sa', 'qa', 'ph', 'eg', 'ng', 'ke']));
const LABELS = { in: 'India', de: 'Germany', fr: 'France', uk: 'the UK', us: 'the USA', ca: 'Canada', au: 'Australia', jp: 'Japan', cn: 'China', sg: 'Singapore', ae: 'the UAE', br: 'Brazil', es: 'Spain', it: 'Italy', nl: 'the Netherlands', za: 'South Africa', np: 'Nepal', lk: 'Sri Lanka', bd: 'Bangladesh', pk: 'Pakistan', id: 'Indonesia', my: 'Malaysia', th: 'Thailand', vn: 'Vietnam', mx: 'Mexico' };
/** The country an ask names: "Indian companies ..." -> { name: 'india', tld: 'in', label: 'India' }, or null. */
export function askCountry(query) {
  const q = ' ' + normName(query) + ' ';
  for (const [name, tld] of Object.entries(COUNTRIES)) if (q.includes(' ' + name + ' ')) return { name, tld, label: LABELS[tld] || tld.toUpperCase() };
  return null;
}
/** The country a site's address says: "northwind-pharma.de" -> "de", "acme.co.in" -> "in", "/de/" path or "de." host on a .com -> "de"; '' when it says none. */
export function siteCountry(url) {
  let u; try { u = new URL(String(url)); } catch { return ''; }
  const parts = u.hostname.toLowerCase().split('.'); const tld = parts[parts.length - 1];
  if (CC_TLDS.has(tld)) return tld;
  const sub = parts.length > 2 ? parts[0] : ''; if (CC_TLDS.has(sub)) return sub;
  const label = hostLabel(url);                                   // "kavyalabsusa.com" -> us, "acme-india.com" -> in
  const named = [[/(usa|america)$/, 'us'], [/india$/, 'in'], [/(deutschland|germany)$/, 'de'], [/(europe|emea)$/, 'eu'], [/japan$/, 'jp'], [/china$/, 'cn'], [/canada$/, 'ca'], [/australia$/, 'au']].find(([re]) => re.test(label));
  if (named && label.replace(named[0], '').length >= 2) return named[1];
  const seg = (u.pathname.split('/')[1] || '').toLowerCase().split(/[-_]/); const hit = seg.find(x => CC_TLDS.has(x));
  return hit && seg.length <= 2 && seg.every(x => x.length === 2) ? hit : '';
}
/** A site that belongs to another country than the ask's: never taken as the lead's site. */
export const wrongCountrySite = (url, country) => { const c = siteCountry(url); return !!(country && c && c !== country.tld); };
// ---- country fit: "Indian companies" and a page that plainly says the company is headquartered or based elsewhere.
// Narrow on purpose: only a plain statement ("headquartered in Lehi, Utah", "based in San Francisco", "Headquarters:
// London") in a sentence about the company, and only when the same text gives no sign of the ask's country. Silence keeps.
const US_STATES = 'alabama alaska arizona arkansas california colorado connecticut delaware florida hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada ohio oklahoma oregon pennsylvania tennessee texas utah vermont virginia washington wisconsin wyoming'.split(' ')
  .concat(['new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'rhode island', 'south carolina', 'south dakota', 'west virginia']);
// signs of the ask's country besides its names: its larger business cities
const SIGNS = { in: ['bengaluru', 'bangalore', 'mumbai', 'delhi', 'new delhi', 'pune', 'chennai', 'hyderabad', 'kolkata', 'ahmedabad', 'noida', 'gurugram', 'gurgaon', 'kochi', 'jaipur', 'chandigarh', 'indore', 'coimbatore'] };
const PLACES = { ...COUNTRIES, ...Object.fromEntries(US_STATES.map(x => [x, 'us'])), america: 'us', 'san francisco': 'us', 'silicon valley': 'us', 'united states of america': 'us', austin: 'us',
  england: 'uk', scotland: 'uk', london: 'uk', berlin: 'de', munich: 'de', paris: 'fr', amsterdam: 'nl', toronto: 'ca', sydney: 'au', melbourne: 'au', tokyo: 'jp', ireland: 'ie', dublin: 'ie', switzerland: 'ch', israel: 'il',
  ...Object.fromEntries(Object.entries(SIGNS).flatMap(([tld, xs]) => xs.map(x => [x, tld]))) };
const PLACED = /\b(?:(?:head-?quartered|based)\s+(?:out of|in|at)|(?:headquarters|head office|hq|registered office)\s*(?:is |are )?(?:located )?(?:in|at|:))\s+([^.;!?\n]{2,80})/gi;
/** The place named first in these words ("San Francisco and an office in Bengaluru, India" -> us), or ''. */
const placeOf = (words) => {
  const t = ' ' + normName(words) + ' '; let best = ''; let at = Infinity;
  for (const [name, tld] of Object.entries(PLACES)) { const i = t.indexOf(' ' + name + ' '); if (i >= 0 && i < at) { at = i; best = tld; } }
  return best;
};
const sentencesOf = (text) => String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
/** A "headquartered in" / "based in" statement at m.index in sentence x is about the company itself: right after its name,
 *  "we", "is", "our", a comma, or a word for a company ("customers based in the USA" is not about where the company is). */
function aboutItself(x, index, company) {
  const before = x.slice(0, index).trim();
  return !before || /(?:^|[\s,(])(?:we|we're|we are|is|are|our|its|company|firm|startup|provider|platform|business|inc\.?|ltd\.?|llc)$/i.test(before) || /[,(—–-]$/.test(before) || [normName(company), coreName(company)].some(n => n && (' ' + normName(before)).endsWith(' ' + n));
}
/** A sign of the ask's country in the text: its names ("India", "Indian"), or one of its larger cities. */
export function countrySign(text, country) {
  if (!country) return false;
  const t = ' ' + normName(text) + ' ';
  const names = Object.entries(COUNTRIES).filter(([, tld]) => tld === country.tld).map(([n]) => n).concat(SIGNS[country.tld] || []);
  return names.some(n => t.includes(' ' + n + ' '));
}
/** The text plainly places the company in another country than the ask's, and gives no sign of the ask's country. */
export function placedElsewhere(text, company, country) {
  if (!country || countrySign(text, country)) return false;
  const sents = sentencesOf(text).filter(x => textNames(x, company) || /\b(we|we're|we are|our)\b/i.test(x));
  for (const x of sents) for (const m of x.matchAll(PLACED)) {
    const c = aboutItself(x, m.index, company) ? placeOf(m[1]) : '';
    if (c && c !== country.tld) return true;
  }
  return false;
}

// ---- country evidence: when the ask names a country, a lead is kept only when a page that was read places the company
// there. Silence is not evidence: a list of "HR software in India" names what is sold there, not where its makers are.
const CALLING = { in: '91', de: '49', fr: '33', uk: '44', us: '1', ca: '1', au: '61', jp: '81', cn: '86', sg: '65', ae: '971', br: '55', es: '34', it: '39', nl: '31', za: '27', np: '977', lk: '94', bd: '880', pk: '92', id: '62', my: '60', th: '66', vn: '84', mx: '52' };
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namesOf = (tld) => Object.entries(COUNTRIES).filter(([, t]) => t === tld).map(([n]) => n);
const phoneRe = (tld) => CALLING[tld] ? new RegExp(`(?:\\+|\\b00)\\s?\\(?${CALLING[tld]}\\)?[\\s.-]*\\d[\\d\\s.-]{6,}`) : null;
// words that may stand between "is a" and the country word ("is a leading Indian"); a preposition may not ("a favourite of Indian startups")
const FREE = '(?:(?!(?:of|for|among|with|in|to|by|across|from|and|or|like)\\b)[\\p{L}-]+\\s+){0,2}?';
/**
 * The text places the company in the ask's country, from what it says about the company itself: a "headquartered in" /
 * "based in" / "registered office:" statement naming a place there; "is an Indian ...", ", a Pune-based ...". On its own
 * site (own) every sentence is about the company ("We are headquartered in Chennai", "Registered office: ..."), and a
 * phone with the country's calling code counts; on another page a phone is the publisher's, never the company's. Returns the words that place it, or ''.
 */
export function placedIn(text, company, country, { own = false } = {}) {
  if (!country?.tld) return '';
  const names = namesOf(country.tld).map(reEsc).join('|'); const cities = [...namesOf(country.tld), ...(SIGNS[country.tld] || [])].map(reEsc).join('|');
  const described = new RegExp(`(?:\\b(?:is|are|was)\\s+(?:(?:a|an)\\s+${FREE})?|,\\s*(?:a|an)\\s+${FREE})(?:(?:${names})\\b(?![- ]based)|(?:${cities})[- ]based\\b)|^(?:the\\s+)?(?:${cities})[- ]based\\b`, 'iu');
  const phone = phoneRe(country.tld);
  // on its own site every sentence is the company's own (a bare "Registered office: ..." line); elsewhere only those naming it
  const sents = sentencesOf(text).filter(x => own || textNames(x, company));
  for (const x of sents) {
    for (const m of x.matchAll(PLACED)) if (aboutItself(x, m.index, company) && placeOf(m[1]) === country.tld) return m[0].trim();
    const d = x.match(described); if (d) return d[0].trim();
  }
  if (own && phone) { const p = String(text || '').match(phone); if (p) return balanceBrackets(p[0].trim()); }
  return '';
}
/** Brackets that do not pair up are dropped ("+91) 93117 76363" -> "+91 93117 76363"); paired ones stay. */
export function balanceBrackets(s) {
  const t = String(s || ''); const drop = new Set(); const open = [];
  for (let i = 0; i < t.length; i++) { if (t[i] === '(') open.push(i); else if (t[i] === ')') { if (open.length) open.pop(); else drop.add(i); } }
  for (const i of open) drop.add(i);
  return [...t].filter((_, i) => !drop.has(i)).join('').replace(/\s{2,}/g, ' ').trim();
}
/** The page itself is a list of companies of the ask's country: its title says so ("Top 10 Indian HR software companies"),
 *  or its title or opening lines say "companies based in India". Not a list of what is sold or used there ("HR software
 *  in India", "for Indian small businesses"), and never the audience in its text ("Indian startups need ..."). Returns the words, or ''. */
export function listPlaces(page, country) {
  if (!country?.tld) return '';
  const names = namesOf(country.tld).map(reEsc).join('|');
  const KIND = '(?:companies|firms|manufacturers|makers|suppliers|brands|vendors|providers|exporters)';
  const title = String(page?.title || ''); const head = `${title}. ${String(page?.text || '').slice(0, 300)}`;
  const m = title.match(new RegExp(`(?<!\\b(?:for|among|to|by|with|of|serving|in|from)\\s)\\b(?:${names})\\s+(?:[\\p{L}&-]+\\s+){0,3}?${KIND}\\b`, 'iu'))
    || head.match(new RegExp(`\\b${KIND}\\s+(?:based|headquartered)\\s+in\\s+(?:${names})\\b`, 'iu'));
  return m ? m[0].trim() : '';
}
/** The need or sector line is kept only when its distinctive words are on the page that names the company. */
export function needOnPage(need, pageText) {
  const words = [...new Set(normName(need).split(' ').filter(w => w.length >= 5 && !STOPWORDS.has(w)))];
  if (!words.length) return true;
  const t = ' ' + normName(pageText) + ' ';
  const hits = words.filter(w => t.includes(' ' + w) || t.includes(' ' + w.slice(0, Math.max(5, w.length - 2)))).length;
  return hits / words.length >= 0.6;
}

/** The country a mail address says in its name: "info.de@example.com" -> "de"; '' when it says none. */
export function emailCountry(e) { const m = String(e || '').toLowerCase().split('@')[0].match(/[._-]([a-z]{2})$/); return m && CC_TLDS.has(m[1]) ? m[1] : ''; }

const STAGE_HOST = /(^|[.-])(stage|staging|dev|test|testing|demo|uat|sandbox|beta|preprod|qa)([.-]|$)/;
const APP_SUB = /^(app|apps|login|portal|payroll|sns|my|secure|accounts?|dashboard|admin|client|customers?|support|help|docs|blog|careers|jobs|mail|web|go|get|try|signup|auth|cloud|erp|hrms|ess)$/;
/**
 * The address to read as a company's own site: '' for a staging or test host (hrdesk-stage.in); the main site for an app
 * or login subdomain (payroll.hivelinksoftware.in -> www.hivelinksoftware.in); otherwise the address's own origin.
 */
export function siteRoot(url) {
  let u; try { u = new URL(String(url)); } catch { return ''; }
  const host = u.hostname.toLowerCase();
  if (STAGE_HOST.test(host)) return '';
  const reg = registrableDomain(url); const sub = host.endsWith('.' + reg) ? host.slice(0, -reg.length - 1) : '';
  return sub && sub !== 'www' && APP_SUB.test(sub.split('.')[0]) ? `https://www.${reg}` : u.origin;
}

// ---- customer size: "for small businesses" against a page that plainly says it serves large companies only.
// Narrow on purpose: "large" only from plain phrases about who it serves, never from a name ("Sharma Enterprises") or
// from "enterprise-grade / -class / -level"; a text that also names small or medium businesses is not "large".
const SMALL_SEG = /\b(small and medium(?:[- ]sized)? (?:enterprises|businesses|companies|firms)|small(?:[- ]sized)? (?:and mid(?:[- ]sized)? )?(?:business(?:es)?|firms?|companies|teams|enterprises|organi[sz]ations)|(?:medium|mid)(?:[- ]sized)? (?:business(?:es)?|firms?|companies|enterprises)|smbs?|smes?|msmes?|start-?ups?)\b/i;
const LARGE_SEG = /\b(for (?:large )?enterprises|for large (?:organi[sz]ations|companies|corporations)|enterprise (?:customers|clients) only|fortune 500|serves? large corporations)\b/i;
/** Which customer size a text names: 'small', 'large', 'both' or ''. */
export function segmentOf(text) {
  const t = String(text || '');
  const small = SMALL_SEG.test(t), large = LARGE_SEG.test(t);
  return small && large ? 'both' : small ? 'small' : large ? 'large' : '';
}
/** The ask names one customer size and the lead's own words name only the other one. Both or neither: no clash. */
export function segmentClash(query, leadText) {
  const ask = segmentOf(query); if (ask !== 'small' && ask !== 'large') return false;
  const lead = segmentOf(leadText);
  return (lead === 'small' || lead === 'large') && lead !== ask;
}
