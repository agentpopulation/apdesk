// Draft honesty: find sentences where the owner's side claims something the owner never gave us (past clients, results,
// numbers, awards, experience, "we have helped ..."). Pure functions; used after every draft is written.
const WE = /\b(we|we've|we're|we'd|we'll|our|ours|us|i've|i have|my team|our team|my company|my business|my firm|i run|i own|i represent|on behalf of|i'?m the owner|i am the owner|i'?m an?|i am an?|i'?m the (?:founder|co-?founder|ceo|head|director|owner)|i am the (?:founder|co-?founder|ceo|head|director)|i founded|i lead|i work (?:at|for)|i'?m with|i am with)\b/i;
const CLAIM = /\b(owner of|founder|co-?founder|ceo|builds?|built|tools|saas|platform|company that|business that|firm that|focus(?:es|ed|ing)? on|provid\w*|offer\w*|solutions?|services?|products?|synerg\w*|helped|help(?:ing)? (?:companies|clients|businesses|plants|firms|teams)|worked with|work with (?:companies|clients|leading)|delivered|served|serving|partnered|clients?|customers?|results?|track record|experience[d]?|expertise|years|award|awarded|certified|certification|proven|trusted|case stud\w*|reduc\w*|increas\w*|sav(?:e|ed|es|ing)|improv\w*|streamlin\w*|optimi[sz]\w*|boost\w*|cut|grow|growth|roi|expert\w*|speciali[sz]\w*|leader|leading|industry-leading|best-in-class|world-class|award-winning|successfully|success|guarantee\w*|percent|\d+(?:[.,]\d+)*)/i;
const STEMS = (s) => String(s || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [];

export function sentences(body) { return String(body || '').replace(/[\u2018\u2019\u02bc]/g, "'").split(/(?<=[.!?])\s+|\n+/).map(x => x.trim()).filter(Boolean); }

// First-person claims of experience, clients, results or relationships: "I work closely with companies in this space",
// "we have helped ...", "our clients ...", "I've seen ...", "we specialise in ...". Never true unless the owner wrote it.
const EXPERIENCE = /\b(?:(?:i|we)\s+(?:also\s+)?(?:work|worked|have worked|'ve worked|partner|partnered|collaborate|collaborated)\s+(?:\w+\s+){0,2}with|(?:i|we)\s*(?:have|'ve)\s+(?:\w+\s+)?helped|(?:i|we)\s+(?:help|helped|support|advise|serve)\s+(?:many\s+|other\s+|several\s+)?(?:companies|businesses|firms|teams|clients|brands|startups|founders)|our\s+(?:clients?|customers?|partners?|portfolio|track record|experience)|my\s+(?:clients?|customers?|experience|track record)|(?:i|we)\s*(?:have|'ve)\s+seen\s+(?!your\b|you\b|that you\b|on your\b)|(?:i|we)\s+(?:speciali[sz]e|focus)\s+(?:in|on)|(?:i|we)\s*(?:have|'ve)\s+(?:\w+\s+){0,2}experience|(?:i|we)\s+know\s+(?:this|the)\s+(?:space|industry|market|sector))/i;
const EXP_PLAIN = new Set(['have', 'also', 'with', 'many', 'other', 'several', 'your', 'that', 'this', 'into']);

/** Sentences claiming something about the owner's side that the offer text (or his business name) does not support. */
export function unsupportedClaims(body, offer = '') {
  const off = new Set(STEMS(offer)); const offNums = new Set((String(offer || '').match(/\d+(?:[.,]\d+)*/g) || []).map(x => x.replace(/\D/g, '')));
  const out = [];
  const inOffer = (w) => [...off].some(o => o.startsWith(w.slice(0, 5)) || w.startsWith(o.slice(0, 5)));
  for (const s of sentences(body)) {
    const ex = s.match(EXPERIENCE);
    if (ex) { const words = STEMS(ex[0]).filter(w => !EXP_PLAIN.has(w)); if (!words.length || !words.every(inOffer)) { out.push(s); continue; } }
    if (!WE.test(s)) continue;
    const m = s.match(new RegExp(CLAIM.source, 'gi')); if (!m) continue;
    // Supported only when every claim word (or number) also appears in what the owner wrote about his offer.
    const low = String(offer || '').toLowerCase();
    const bad = m.filter(w => /^\d/.test(w) ? !offNums.has(w.replace(/\D/g, '')) && !new RegExp(`\\b${w}\\s*-?\\s*(minutes?|mins?|hours?)\\b`, 'i').test(s) : STEMS(w).length === 0 ? !new RegExp(`\\b${w.toLowerCase()}\\b`).test(low) : !STEMS(w).some(x => [...off].some(o => o.startsWith(x.slice(0, 5)) || x.startsWith(o.slice(0, 5)))));
    if (bad.length) out.push(s);
  }
  return out;
}
/** Remove the given sentences from a body, keeping its lines. */
export function removeSentences(body, bad) {
  let out = String(body || '').replace(/[\u2018\u2019\u02bc]/g, "'");
  for (const s of bad) { const g = s.match(/^(hello|hi|dear [^,]{1,40}|good \w+)\s*(\[[^\]]*\])?\s*[,!]/i); out = out.replace(s, g ? g[1] + ',' : ''); }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
}

const NAME_INTRO = /\b(?:I'?m|I am|my name is)\s+([A-Z][\w'-]*(?:\s+(?!I\b)[A-Z][\w'-]*){0,2})/g;
const SIGNOFF = /\b(?:best|regards|best regards|kind regards|warm regards|thanks|thank you|sincerely|cheers)[,!.]?\s*\n+\s*([^\n]{2,60})\s*$/i;
const NOT_NAMES = /^(?:reaching|writing|contacting|interested|curious|keen|happy|glad|excited|looking|hoping|following|from|with|at|here|the|a|an|sure|impressed)\b/i;
/** Names the draft gives the sender that are not the owner's (an invented "Rohan", a "[Your Name]" placeholder). */
export function senderNameProblems(body, ownerName = '') {
  body = String(body || '').replace(/[\u2018\u2019\u02bc]/g, "'");
  const own = String(ownerName || '').toLowerCase().trim(); const out = [];
  const bad = (n) => { const x = String(n || '').trim(); if (!x || NOT_NAMES.test(x)) return false; if (/your name|\[|\{|name here/i.test(x)) return true; if (!own) return /^[A-Z]/.test(x); return !own.split(/\s+/).some(w => w.length > 1 && x.toLowerCase().includes(w)); };
  for (const m of String(body || '').matchAll(NAME_INTRO)) if (bad(m[1])) out.push(m[0]);
  for (const m of String(body || '').matchAll(/\[[^\]\n]{1,40}\]|\{[^}\n]{1,40}\}|<[A-Z][^>\n]{1,30}>|your name here/gi)) out.push(m[0]);
  const s = String(body || '').match(SIGNOFF); if (s && bad(s[1]) && !/^(?:the|your|team)\b/i.test(s[1])) out.push(s[1].trim());
  return [...new Set(out)];
}

/** Remove an invented sender name: the sentence that introduces it, or the name under the sign-off. */
export function stripSenderNames(body, problems, ownerName = '') {
  let out = String(body || '');
  for (const p of problems) {
    const sent = sentences(out).find(x => x.includes(p));
    if (sent && sent !== p.trim()) { const g = sent.match(/^(hello|hi|dear [^,]{1,40}|good \w+)[,!]/i); out = out.replace(sent, g ? g[0] : ''); }
    else out = out.replace(new RegExp('\\n\\s*' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$'), ownerName ? '\n' + ownerName : '');
  }
  return out.replace(/\s?(\[[^\]\n]{1,40}\]|\{[^}\n]{1,40}\}|<[A-Z][^>\n]{1,30}>|your name here)/gi, '').replace(/ ,/g, ',').replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** "Hello Meera," when the lead gives no contact of that name: a greeting name the facts did not give. */
export function greetingNameProblems(body, contactName = '') {
  const m = String(body || '').replace(/[‘’]/g, "'").match(/^\s*(?:hello|hi|dear|hey)\s+([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*)?)\s*[,!]/i);
  if (!m) return [];
  const n = m[1].trim(); const c = String(contactName || '').toLowerCase();
  if (/^(team|there|all|sir|madam|everyone)$/i.test(n)) return [];
  return c && n.toLowerCase().split(/\s+/).some(w => w.length > 1 && c.includes(w.replace(/\.$/, ''))) ? [] : [m[0].trim()];
}

// Filler that says nothing true or useful: replaced by the plain default (who the owner is, why this company, a short call).
const FILLER = [/\bsee how you (?:approach|handle|manage|run|do)\b/i, /\bsince you(?:'re| are) (?:working|involved|active) (?:with|in) (?:this|the|that) (?:product|space|field|area|industry)\b/i, /\b(?:companies|businesses|players) in (?:this|your) space\b/i, /\bexplore (?:potential |possible )?(?:synerg\w*|opportunit\w* together|ways to work together)\b/i, /\b(?:learn|hear) more about how you (?:approach|handle|do)\b/i];
/** Filler sentences in a body. */
export function fillerSentences(body) { return sentences(body).filter(s => FILLER.some(r => r.test(s))); }
/** The plain default message: who the owner is, one line on why this company (its Need, which came from a page), a short call. */
export function plainDefault({ owner = '', business = '', company = '', contactName = '', need = '', channel = 'email' } = {}) {
  const first = String(contactName || '').trim().split(/\s+/)[0] || '';
  const who = owner ? `I am ${owner}${business ? ` from ${business}` : ''}.` : business ? `I am writing from ${business}.` : '';
  const n = String(need || '').replace(/\s*Also listed as [^.]*\.?/g, '').replace(/[\s.;,:]+$/, '').trim();
  // the need keeps its own case ("GST filing", "provides ..."): after a colon either first letter reads naturally
  const why = n ? `I came across ${company}. What I read about you: ${n}.` : `I came across ${company} and would like to hear what you need.`;
  const lines = [`Hello${first ? ' ' + first : ''},`, [who, why].filter(Boolean).join(' '), channel === 'email' ? 'Could we have a short call next week?' : 'Could we have a short call?'];
  if (owner && channel === 'email') lines.push(`Best regards,\n${owner}`);
  return lines.join('\n\n');
}

// ---- language and script of a draft
const SCRIPTS = { hindi: ['Devanagari', /\p{Script=Devanagari}/u], marathi: ['Devanagari', /\p{Script=Devanagari}/u], nepali: ['Devanagari', /\p{Script=Devanagari}/u], tamil: ['Tamil', /\p{Script=Tamil}/u], malayalam: ['Malayalam', /\p{Script=Malayalam}/u], bengali: ['Bengali', /\p{Script=Bengali}/u], bangla: ['Bengali', /\p{Script=Bengali}/u], telugu: ['Telugu', /\p{Script=Telugu}/u], kannada: ['Kannada', /\p{Script=Kannada}/u], gujarati: ['Gujarati', /\p{Script=Gujarati}/u], punjabi: ['Gurmukhi', /\p{Script=Gurmukhi}/u], odia: ['Odia', /\p{Script=Oriya}/u], urdu: ['Arabic', /\p{Script=Arabic}/u], english: ['Latin', /\p{Script=Latin}/u] };
/** A plain language name ("Hindi", "tamil") -> { name: 'Hindi', script: 'Devanagari', re } or null when not given / not known. */
export function languageOf(language) {
  const k = String(language || '').trim().toLowerCase(); if (!k) return null;
  const hit = SCRIPTS[k]; const name = k.charAt(0).toUpperCase() + k.slice(1);
  return hit ? { name, script: hit[0], re: hit[1] } : { name, script: '', re: null };
}
/**
 * The body is not mostly in the language's script: '' when fine, else a plain reason. Letters only are counted; names
 * (company, contact, owner), mail addresses, web addresses and numbers are left out first.
 */
export function scriptProblem(body, language, ignore = []) {
  const lang = languageOf(language); if (!lang?.re) return '';
  let t = String(body || '').replace(/\S+@\S+/g, ' ').replace(/https?:\/\/\S+|www\.\S+/gi, ' ');
  for (const n of ignore.filter(Boolean)) for (const w of String(n).split(/\s+/).filter(x => x.length > 1)) t = t.split(w).join(' ');
  const letters = [...t].filter(ch => /\p{L}/u.test(ch));
  if (!letters.length) return `the message has no ${lang.name} text`;
  const share = letters.filter(ch => lang.re.test(ch)).length / letters.length;
  return share >= 0.6 ? '' : `the message is not in ${lang.name} (${lang.script} script)`;
}
