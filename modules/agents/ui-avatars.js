// Agent avatars: a small set of drawn characters and shapes on a colour, or the agent's letters on a colour.
// One file for both sides: the core checks a choice against AVATARS and COLOURS; pages draw it with avatarEl().
// The file name starts with "ui" because the desk serves only ui*.js files of a module to the window.
// Every drawing is our own simple shapes on a 48 x 48 grid: white shapes, dark ink for eyes, a warm yellow here and there.

const W = '#ffffff', K = '#1b1440', Y = '#ffd36b', S = 'rgba(255,255,255,.55)';
// An eye is two groups: "pu" moves (the pupil follows the pointer), "ey" blinks. Both are driven by the CSS and script below.
const eye = (inner) => `<g class="pu"><g class="ey">${inner}</g></g>`;
const eyes = (y = 24, dx = 5, r = 2.2, c = K) => eye(`<circle cx="${24 - dx}" cy="${y}" r="${r}" fill="${c}"/>`) + eye(`<circle cx="${24 + dx}" cy="${y}" r="${r}" fill="${c}"/>`);
const smile = (y = 30, w = 4) => `<path d="M${24 - w} ${y} Q24 ${y + 3.5} ${24 + w} ${y}" fill="none" stroke="${K}" stroke-width="2" stroke-linecap="round"/>`;

/** id, the name the owner reads in the picker, and the drawing. Order is the order of the picker. */
export const AVATARS = [
  ['robot', 'Robot', `<line x1="24" y1="8" x2="24" y2="14" stroke="${W}" stroke-width="2.4"/><circle cx="24" cy="7" r="2.6" fill="${Y}"/><rect x="11" y="14" width="26" height="21" rx="6" fill="${W}"/>${eyes(23, 5.5, 2.6)}<rect x="18.5" y="29" width="11" height="2.6" rx="1.3" fill="${K}"/>`],
  ['owl', 'Owl', `<path d="M12 17 L15 8 L21 15 Z M36 17 L33 8 L27 15 Z" fill="${W}"/><ellipse cx="24" cy="27" rx="13" ry="13.5" fill="${W}"/><circle cx="18.5" cy="24" r="4.8" fill="${Y}"/><circle cx="29.5" cy="24" r="4.8" fill="${Y}"/>${eyes(24, 5.5, 2.2)}<path d="M22 29 H26 L24 33 Z" fill="${K}"/>`],
  ['fox', 'Fox', `<path d="M9 12 L18 19 H30 L39 12 L35 29 Q24 41 13 29 Z" fill="${W}"/><path d="M13 29 Q24 23 35 29 Q24 41 13 29 Z" fill="${S}"/>${eyes(25, 5.5)}<circle cx="24" cy="32" r="2" fill="${K}"/>`],
  ['cat', 'Cat', `<path d="M12.5 22 L13.5 9 L22 15.5 Z M35.5 22 L34.5 9 L26 15.5 Z" fill="${W}"/><circle cx="24" cy="27" r="12" fill="${W}"/>${eye(`<ellipse cx="19" cy="25" rx="1.8" ry="2.8" fill="${K}"/>`)}${eye(`<ellipse cx="29" cy="25" rx="1.8" ry="2.8" fill="${K}"/>`)}<path d="M22.5 29.5 H25.5 L24 31.5 Z" fill="${K}"/><path d="M8 28 H16 M8 32 L16 30.5 M40 28 H32 M40 32 L32 30.5" stroke="${S}" stroke-width="1.5" stroke-linecap="round"/>`],
  ['bear', 'Bear', `<circle cx="14" cy="15" r="5.5" fill="${W}"/><circle cx="34" cy="15" r="5.5" fill="${W}"/><circle cx="24" cy="26" r="13" fill="${W}"/><ellipse cx="24" cy="30.5" rx="6.5" ry="5" fill="${S}"/>${eyes(23, 5.5)}<ellipse cx="24" cy="28.5" rx="2.6" ry="1.9" fill="${K}"/>`],
  ['rabbit', 'Rabbit', `<ellipse cx="19" cy="13" rx="3.6" ry="9.5" fill="${W}"/><ellipse cx="29" cy="13" rx="3.6" ry="9.5" fill="${W}"/><circle cx="24" cy="29" r="11" fill="${W}"/>${eyes(28, 4.5)}<ellipse cx="24" cy="32" rx="1.8" ry="1.4" fill="${K}"/>`],
  ['penguin', 'Penguin', `<ellipse cx="24" cy="26" rx="13" ry="15" fill="${K}"/><ellipse cx="24" cy="29" rx="8.5" ry="11" fill="${W}"/>${eye(`<circle cx="20" cy="21" r="2.4" fill="${W}"/>`)}${eye(`<circle cx="28" cy="21" r="2.4" fill="${W}"/>`)}<path d="M21.5 25 H26.5 L24 28.5 Z" fill="${Y}"/>`],
  ['frog', 'Frog', `<circle cx="16" cy="19" r="6" fill="${W}"/><circle cx="32" cy="19" r="6" fill="${W}"/><ellipse cx="24" cy="29" rx="15" ry="10" fill="${W}"/>${eyes(19, 8, 2.6)}${smile(30, 6)}`],
  ['octopus', 'Octopus', `<path d="M12 24 A12 12 0 0 1 36 24 V30 H12 Z" fill="${W}"/><path d="M13 29 Q12 37 9 39 M19 30 Q19 38 17 41 M29 30 Q29 38 31 41 M35 29 Q36 37 39 39" stroke="${W}" stroke-width="3.2" fill="none" stroke-linecap="round"/>${eyes(22, 5)}${smile(26, 3)}`],
  ['whale', 'Whale', `<path d="M7 28 Q8 16 24 16 Q37 16 39 25 L45 19 L44 31 Q40 36 26 36 H14 Q7 36 7 28 Z" fill="${W}"/>${eye(`<circle cx="16" cy="25" r="2" fill="${K}"/>`)}<path d="M17 31 Q22 33 27 31" stroke="${K}" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M22 13 V8 M22 9 Q19 7 17 8 M22 9 Q25 7 27 8" stroke="${S}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`],
  ['bee', 'Bee', `<ellipse cx="17" cy="16" rx="6" ry="4.5" fill="${S}"/><ellipse cx="31" cy="16" rx="6" ry="4.5" fill="${S}"/><ellipse cx="24" cy="28" rx="12" ry="10" fill="${Y}"/><path d="M19 19 V37 M27 18.5 V37.5" stroke="${K}" stroke-width="3"/>${eye(`<circle cx="33" cy="26" r="1.8" fill="${K}"/>`)}`],
  ['panda', 'Panda', `<circle cx="13.5" cy="15" r="5" fill="${K}"/><circle cx="34.5" cy="15" r="5" fill="${K}"/><circle cx="24" cy="26" r="13" fill="${W}"/><g class="ey"><ellipse cx="18.5" cy="24" rx="3.6" ry="4.4" fill="${K}"/></g><g class="ey"><ellipse cx="29.5" cy="24" rx="3.6" ry="4.4" fill="${K}"/></g>${eye(`<circle cx="19" cy="23.5" r="1.2" fill="${W}"/>`)}${eye(`<circle cx="29" cy="23.5" r="1.2" fill="${W}"/>`)}<ellipse cx="24" cy="30.5" rx="2.4" ry="1.7" fill="${K}"/>`],
  ['lion', 'Lion', `<circle cx="24" cy="25" r="16" fill="${Y}"/><circle cx="24" cy="26" r="10.5" fill="${W}"/>${eyes(24, 4.2, 1.9)}<path d="M22 28 H26 L24 30.5 Z" fill="${K}"/>${smile(31.5, 3)}`],
  ['koala', 'Koala', `<circle cx="12" cy="20" r="7" fill="${W}"/><circle cx="36" cy="20" r="7" fill="${W}"/><circle cx="12" cy="20" r="3.5" fill="${S}"/><circle cx="36" cy="20" r="3.5" fill="${S}"/><circle cx="24" cy="26" r="12" fill="${W}"/>${eyes(23, 5)}<ellipse cx="24" cy="29" rx="3.4" ry="4.6" fill="${K}"/>`],
  ['chick', 'Chick', `<path d="M22 13 Q24 8 26 13" stroke="${Y}" stroke-width="2.4" fill="none" stroke-linecap="round"/><circle cx="24" cy="27" r="13" fill="${Y}"/>${eyes(24, 5)}<path d="M21 28 H27 L24 32 Z" fill="#f08a24"/>`],
  ['dino', 'Dinosaur', `<path d="M14 17 L17 11 L20 16 L23 10 L26 15 L29 10 L32 16 Z" fill="${S}"/><rect x="10" y="15" width="28" height="22" rx="11" fill="${W}"/>${eyes(24, 6)}<circle cx="21" cy="31" r="1" fill="${K}"/><circle cx="27" cy="31" r="1" fill="${K}"/>`],
  ['ghost', 'Ghost', `<path d="M12 38 V23 A12 12 0 0 1 36 23 V38 L32 35 L28 38 L24 35 L20 38 L16 35 Z" fill="${W}"/>${eye(`<ellipse cx="19.5" cy="23" rx="2" ry="3" fill="${K}"/>`)}${eye(`<ellipse cx="28.5" cy="23" rx="2" ry="3" fill="${K}"/>`)}<ellipse cx="24" cy="30" rx="2.5" ry="2" fill="${K}"/>`],
  ['star', 'Star', `<path d="M24 7 L29 18.5 L41.5 19.5 L32 28 L35 40.5 L24 34 L13 40.5 L16 28 L6.5 19.5 L19 18.5 Z" fill="${W}" stroke="${W}" stroke-width="2" stroke-linejoin="round"/>${eyes(24, 4, 1.8)}${smile(28, 2.6)}`],
  ['planet', 'Planet', `<circle cx="24" cy="24" r="10.5" fill="${W}"/><ellipse cx="24" cy="24" rx="19" ry="6" fill="none" stroke="${Y}" stroke-width="2.4" transform="rotate(-18 24 24)"/><path d="M14.5 21 A10.5 10.5 0 0 1 33.5 21" fill="none" stroke="${W}" stroke-width="3"/><circle cx="20" cy="27" r="2" fill="${S}"/><circle cx="27" cy="21" r="1.4" fill="${S}"/>`],
  ['rocket', 'Rocket', `<path d="M24 6 Q33 14 31 31 H17 Q15 14 24 6 Z" fill="${W}"/><circle cx="24" cy="19" r="3.6" fill="${K}"/><path d="M17 25 L11 33 L17 31 Z M31 25 L37 33 L31 31 Z" fill="${S}"/><path d="M20 33 Q24 43 28 33 Z" fill="${Y}"/>`],
  ['leaf', 'Leaf', `<path d="M10 38 Q9 13 38 9 Q41 35 14 38 Z" fill="${W}"/><path d="M12 37 Q22 25 33 14" stroke="${S}" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M19 30 L18 22 M24 25 L30 25" stroke="${S}" stroke-width="1.6" stroke-linecap="round"/>`],
  ['mountain', 'Mountain', `<circle class="tw" cx="34" cy="13" r="4.5" fill="${Y}"/><path d="M5 38 L19 16 L33 38 Z" fill="${W}"/><path d="M23 38 L32 24 L43 38 Z" fill="${S}"/><path d="M15 22.5 L19 16 L23 22.5 L19 21 Z" fill="${S}"/>`],
  ['compass', 'Compass', `<circle cx="24" cy="24" r="15" fill="none" stroke="${W}" stroke-width="3"/><g class="nd"><path d="M24 12 L28 24 L24 36 L20 24 Z" fill="${W}"/><path d="M24 12 L28 24 H20 Z" fill="${Y}"/></g><circle cx="24" cy="24" r="2" fill="${K}"/>`],
  ['bulb', 'Light bulb', `<path d="M24 9 A11 11 0 0 1 30.5 29 V32 H17.5 V29 A11 11 0 0 1 24 9 Z" fill="${Y}"/><rect x="18" y="33" width="12" height="3" rx="1.5" fill="${W}"/><rect x="20" y="37.5" width="8" height="3" rx="1.5" fill="${W}"/><path d="M21 25 L24 21 L27 25" stroke="${K}" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path class="tw" d="M7 20 H10 M38 20 H41 M11 9 L13 11 M37 9 L35 11" stroke="${W}" stroke-width="2" stroke-linecap="round"/>`],
].map(([id, label, art]) => ({ id, label, art }));

/** Colours: the look's own two-stop gradients, so dark and light themes each get their own depth. */
export const COLOURS = [
  ['violet', 'Violet', '--m-ap'], ['purple', 'Purple', '--m-ta'], ['pink', 'Pink', '--m-gq'], ['blue', 'Blue', '--m-or'], ['teal', 'Teal', '--m-se'],
  ['green', 'Green', '--m-ol'], ['amber', 'Amber', '--m-gg'], ['orange', 'Orange', '--m-mi'], ['slate', 'Slate', '--m-cb'],
].map(([id, label, token]) => ({ id, label, token }));

export const LETTER = 'letter';
const LOOKS = new Set([LETTER, ...AVATARS.map(a => a.id)]);
const HUES = new Set(COLOURS.map(c => c.id));

/** A stored choice, checked: { look, colour } with both from the set, else null. */
export function avatarValue(v) {
  if (!v || typeof v !== 'object') return null;
  const look = String(v.look || ''), colour = String(v.colour || '');
  return LOOKS.has(look) && HUES.has(colour) ? { look, colour } : null;
}
/** An agent with no choice yet: its letters on a colour that stays the same for its id. */
export function defaultAvatar(id = '') {
  let n = 0; for (const ch of String(id)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return { look: LETTER, colour: COLOURS[n % COLOURS.length].id };
}
export const letters = (name) => String(name || '?').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
export const lookLabel = (look) => look === LETTER ? 'Letters' : (AVATARS.find(a => a.id === look)?.label || 'Letters');

/**
 * The avatar element for an agent ({ id, name, avatar }), for any page: <span class="agav"> with the drawing or the letters.
 * size: '' (40 px) | 's' (28 px, lists and bubbles) | 'l' (72 px, the agent's own header). Decorative: the name is beside it.
 * opts (optional, last): { state } or just the state word: 'working' | 'waiting' | 'idle' | 'failed'. No state means calm, eyes alive.
 * A drawing with eyes blinks and its pupils follow the pointer; one without sways or twinkles. The letter avatar never moves.
 */
export function avatarEl(agent, size = '', choice = null, opts = null) {
  const a = avatarValue(choice) || avatarValue(agent?.avatar) || defaultAvatar(agent?.id);
  const el = document.createElement('span');
  el.className = 'agav' + (size ? ' ' + size : '');
  el.setAttribute('aria-hidden', 'true');
  el.dataset.look = a.look;
  el.style.background = `var(${COLOURS.find(c => c.id === a.colour).token})`;
  const art = AVATARS.find(x => x.id === a.look);
  if (!art) { el.textContent = letters(agent?.name); return el; }
  el.innerHTML = `<svg viewBox="0 0 48 48" width="100%" height="100%">${art.art}</svg>`;   // our own constant drawings, never input
  el.dataset.eyes = art.art.includes('class="ey"') ? '1' : '0';
  const r = Math.random();   // each avatar blinks and sways on its own rhythm, so a list never moves in step
  el.style.setProperty('--bd', (3.6 + r * 3.6).toFixed(2) + 's');
  el.style.setProperty('--bl', '-' + (Math.random() * 7).toFixed(2) + 's');
  el.style.setProperty('--sd', (5 + Math.random() * 3).toFixed(2) + 's');
  setAvatarState(el, (typeof opts === 'string' ? opts : opts?.state) ?? agent?.avatarState);
  life.add(el);
  return el;
}
/** Change the state of an avatar already on the page (letters ignore it). */
export function setAvatarState(el, state) {
  if (!el || !el.dataset) return;
  if (el.dataset.look === LETTER) return;
  if (STATES.has(state)) el.dataset.state = state; else delete el.dataset.state;
  life.restart(el);
}

// ---- life: blinking and swaying are CSS animations; the pupils follow the pointer from one shared listener ----
export const STATES = new Set(['idle', 'working', 'waiting', 'failed']);
const REACH = 1.7, NEAR = 360;   // pupil travel in drawing units (about 1 to 2 px), and how close the pointer must be
const REST = { waiting: [0, 1.1], failed: [0, 1.3] };   // waiting looks out toward the owner; failed looks down
const life = (() => {
  const set = new Set(), seen = new WeakMap(); let on = false, sweeper = 0, raf = 0, px = 0, py = 0, has = false, io = null;
  const reduced = () => { try { return !!matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  const html = () => document.documentElement;
  const moving = () => html().dataset.avmotion === 'on' && !reduced() && !document.hidden;
  const watch = (el) => { try { if (!io && typeof IntersectionObserver === 'function') io = new IntersectionObserver((es) => { for (const e of es) e.target.classList.toggle('avoff', !e.isIntersecting); }, { rootMargin: '80px' }); io?.observe(el); } catch {} };
  const set2 = (el, x, y) => { x = Math.round(x * 10) / 10; y = Math.round(y * 10) / 10; if (el.dataset.px !== String(x) || el.dataset.py !== String(y)) { el.dataset.px = x; el.dataset.py = y; el.style.setProperty('--px', x); el.style.setProperty('--py', y); } };
  const aim = (el, near) => {
    const st = el.dataset.state, rest = REST[st] || [0, 0];
    if (el.dataset.eyes !== '1' || el.classList.contains('avoff') || st === 'failed' || !near) return set2(el, rest[0], rest[1]);
    const b = el.getBoundingClientRect(), dx = px - (b.left + b.width / 2), dy = py - (b.top + b.height / 2), d = Math.hypot(dx, dy);
    if (d > NEAR) return set2(el, rest[0], rest[1]);
    const k = Math.min(1, d / 40) * REACH * (st === 'waiting' ? 1.2 : 1);   // centred pupils when the pointer is right on it
    set2(el, d ? dx / d * k : 0, d ? dy / d * k : 0);
  };
  const tick = () => { raf = 0; if (!set.size) return; const near = has && moving(); for (const el of set) aim(el, near); };
  const ask = () => { if (!raf) raf = requestAnimationFrame(tick); };
  const avatarPointer = (e) => { px = e.clientX; py = e.clientY; has = true; ask(); };
  const vis = () => { html().classList.toggle('avhid', document.hidden); ask(); };
  const sweep = () => {   // one shared check every few seconds: forget avatars that left the page, and let go of the listener when none is left
    const now = Date.now();
    for (const el of set) if (!el.isConnected && now - (seen.get(el) || 0) > 1500) { set.delete(el); try { io?.unobserve(el); } catch {} }
    if (!set.size) stop();
  };
  const start = () => {
    if (on) return; on = true;
    html().classList.add('avlive');
    document.addEventListener("pointermove", avatarPointer, { passive: true });
    document.addEventListener('visibilitychange', vis);
    sweeper = setInterval(sweep, 3000);
    settle();
  };
  const stop = () => {
    if (!on) return; on = false;
    document.removeEventListener("pointermove", avatarPointer); document.removeEventListener('visibilitychange', vis);
    clearInterval(sweeper); if (raf) cancelAnimationFrame(raf); raf = 0; has = false;
    try { io?.disconnect(); } catch {} io = null;
  };
  return {
    add(el) { seen.set(el, Date.now()); set.add(el); watch(el); start(); ask(); },
    restart(el) { if (set.has(el)) { delete el.dataset.px; ask(); } },
    stats: () => ({ avatars: set.size, listening: on }),
    sweep, ask,
  };
})();
/** How many avatars the shared script is looking after, and whether its one pointer listener is on (for the screen check). */
export const avatarLifeStats = () => life.stats();
export const avatarLifeSweep = () => life.sweep();

// The owner's switch "Avatar motion" (desk-wide, in the settings as ui.avatarMotion). Until it is read, nothing moves.
export const MOTION_KEY = 'ui.avatarMotion';
export function setAvatarMotion(on) { if (typeof document !== 'undefined') { document.documentElement.dataset.avmotion = on === false ? 'off' : 'on'; life.ask(); } }
function settle() {
  if (typeof document === 'undefined' || document.documentElement.dataset.avmotion) return;
  document.documentElement.dataset.avmotion = 'wait';
  const token = document.querySelector('meta[name="apd-session"]')?.content || (() => { try { return sessionStorage.getItem('apd-session') || ''; } catch { return ''; } })();
  fetch('/api/settings', { headers: { 'x-apd-session': token } }).then(r => r.ok ? r.json() : {}).catch(() => ({}))
    .then((s) => setAvatarMotion(s?.[MOTION_KEY] !== false));
}

// The avatar's look, once per window, so any page that uses avatarEl gets it.
const STAND = '0 4px 12px rgba(0,0,0,.18),inset 0 1px 0 rgba(255,255,255,.25)';
const dot = (c) => `.agav[data-state="${c[0]}"]::after{content:"";position:absolute;right:4px;top:4px;width:9px;height:9px;border-radius:50%;background:${c[1]};box-shadow:0 0 0 2px rgba(0,0,0,.28)}`;
const CSS = [
  `.agav{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;flex-shrink:0;overflow:hidden;color:#fff;font-weight:700;font-size:14px;letter-spacing:.02em;box-shadow:${STAND}}`,
  '.agav svg{display:block;width:84%;height:84%}.agav.s{width:28px;height:28px;border-radius:9px;font-size:11px}.agav.l{width:72px;height:72px;border-radius:20px;font-size:24px}',
  // state marks (they stay when motion is off)
  '.agav[data-state]{position:relative}',
  dot(['waiting', 'var(--warn,#f5a524)']), dot(['failed', 'var(--fail,#e5484d)']),
  `.agav[data-state="working"]{box-shadow:${STAND},0 0 0 2px color-mix(in srgb,var(--brand,#a679ff) 55%,transparent)}`,
  // eyes
  '.agav .pu{transform:translate(calc(var(--px,0)*1px),calc(var(--py,0)*1px));transition:transform .24s ease-out}',
  '.agav .ey,.agav .tw,.agav .nd{transform-box:fill-box;transform-origin:center}',
  // motion: only while the page says it may move, the avatar is on screen, and the tab is shown
  'html[data-avmotion="on"] .agav:not(.avoff) .ey{animation:avblink var(--bd,5s) var(--bl,0s) infinite}',
  'html[data-avmotion="on"] .agav:not(.avoff)[data-eyes="0"] svg{transform-origin:50% 85%;animation:avsway var(--sd,6s) var(--bl,0s) ease-in-out infinite}',
  'html[data-avmotion="on"] .agav:not(.avoff) .tw{animation:avtwinkle var(--sd,6s) var(--bl,0s) ease-in-out infinite}',
  'html[data-avmotion="on"] .agav:not(.avoff) .nd{animation:avneedle var(--sd,6s) var(--bl,0s) ease-in-out infinite}',
  'html[data-avmotion="on"] .agav[data-state="working"][data-eyes]:not(.avoff) svg{animation:avbob 1.8s ease-in-out infinite}',
  'html[data-avmotion="on"] .agav[data-state="working"]:not(.avoff){animation:avring 2.2s ease-out infinite}',
  'html[data-avmotion="on"] .agav[data-state="failed"][data-eyes]:not(.avoff) svg{animation:avdroop .7s ease-out forwards}',
  'html.avhid .agav,html.avhid .agav *{animation-play-state:paused!important}',
  '@keyframes avblink{0%,95%,100%{transform:scaleY(1)}97.5%{transform:scaleY(.08)}}',
  '@keyframes avsway{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}',
  '@keyframes avtwinkle{0%,100%{opacity:1}50%{opacity:.45}}',
  '@keyframes avneedle{0%,100%{transform:rotate(-8deg)}50%{transform:rotate(8deg)}}',
  '@keyframes avbob{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.5px)}}',
  `@keyframes avring{0%{box-shadow:${STAND},0 0 0 2px color-mix(in srgb,var(--brand,#a679ff) 60%,transparent)}100%{box-shadow:${STAND},0 0 0 7px transparent}}`,
  '@keyframes avdroop{0%{transform:none}100%{transform:translateY(1.5px) rotate(-4deg)}}',
  '.agav[data-state="failed"] svg{transform:translateY(1.5px) rotate(-4deg)}',
  // switched off in Settings, or the system asks for less motion: nothing moves
  'html[data-avmotion="off"] .agav,html[data-avmotion="off"] .agav *,html[data-avmotion="wait"] .agav,html[data-avmotion="wait"] .agav *{animation:none!important;transition:none!important}',
  '@media (prefers-reduced-motion:reduce){.agav,.agav *{animation:none!important;transition:none!important}}',
].join('');
if (typeof document !== 'undefined' && !document.getElementById('apd-agav-css')) {
  const s = document.createElement('style'); s.id = 'apd-agav-css'; s.textContent = CSS; document.head.append(s);
}
