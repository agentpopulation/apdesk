// The owner's own words about his business (Settings › General, "What you do"), and the one structural test on a lead
// search or draft offer: does it name a kind of business of its own, or only "my product"?
export const ABOUT_KEY = 'business.about';
export const ABOUT_MAX = 600;
export const ASK_ABOUT = 'Before I look: what do you sell, who buys it, and where? One line is enough.';
/** The one line after he answered: what was saved, so he can see it and correct it. */
export const savedLine = (about) => `Saved: "${(about.length > 160 ? about.slice(0, 157).replace(/\s+\S*$/, '') + '…' : about).replace(/[.!]+$/, '')}". You can change it in Settings › General.`;

/** The stored text, trimmed and capped; '' when he has not given it. */
export function aboutOf(settings) { return clipAbout(settings?.get?.(ABOUT_KEY)); }
export const clipAbout = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, ABOUT_MAX);

// "my product", "our company", "my own business" ...: words that point at the owner's business without naming it
const OWN = /\b(?:my|our)\s+(?:own\s+)?(?:products?|company|companies|business(?:es)?|services?|offerings?|offers?|startup|brand|shop|store|firm|solution|app|tool)\b/gi;
// words a lead query carries whatever it is about; what is left after these and OWN is the topic
const FILLER = new Set(['a', 'an', 'the', 'for', 'of', 'to', 'in', 'on', 'with', 'and', 'or', 'that', 'who', 'which', 'would', 'could', 'might', 'may', 'can', 'need', 'needs', 'want', 'wants', 'use', 'buy', 'buys', 'like', 'find', 'get', 'me', 'my', 'our', 'some', 'any', 'all', 'more', 'top', 'best', 'good', 'new', 'potential', 'possible', 'likely', 'interested', 'leads', 'lead', 'sources', 'source', 'companies', 'company', 'businesses', 'customers', 'customer', 'clients', 'client', 'buyers', 'buyer', 'prospects', 'prospect', 'people', 'firms', 'organisations', 'organizations', 'it', 'this', 'them', 'is', 'are', 'be']);

/** True when the text points at the owner's business ("my product") and names no kind of business of its own. */
export function onlyOwnBusiness(text) {
  const t = String(text || '');
  if (!t.match(OWN)) return false;
  const left = t.replace(OWN, ' ').toLowerCase().split(/[^a-zÀ-ɏऀ-෿]+/).filter(w => w && !/^\d+$/.test(w) && !FILLER.has(w));
  return left.length === 0;
}
