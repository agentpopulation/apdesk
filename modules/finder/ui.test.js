// The Finder page on a small stand-in for the page kit: what the owner reads and what each button says back.
import test from 'node:test'; import assert from 'node:assert/strict';

class El {
  constructor(tag, attrs = {}, kids = []) { this.tag = tag; this.attrs = {}; this.kids = []; this.value = ''; this.classList = { add() {} }; for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) this.attrs[k] = v; this.append(...kids); }
  append(...k) { for (const c of k.flat(Infinity)) if (c != null && c !== false && c !== '') this.kids.push(c); }
  replaceChildren(...k) { this.kids = []; this.append(...k); }
  getAttribute(k) { return this.attrs[k] ?? null; } setAttribute(k, v) { this.attrs[k] = v; } focus() {}
}
const text = (n) => (typeof n === 'string' ? n : n instanceof El ? n.kids.map(text).join(' ') : '');
const all = (n, f, out = []) => { if (n instanceof El) { if (f(n)) out.push(n); n.kids.forEach((k) => all(k, f, out)); } return out; };
const tick = () => new Promise((r) => setTimeout(r, 0));

async function page({ online = true, lib = {}, find, fail = {} } = {}) {
  const toasts = []; const calls = [];
  const state = { pages: 0, bytes: 0, oldest: null, limitMb: 100, neverKeep: [], modelWording: false, ...lib };
  const routes = {
    '/api/m/finder/library': () => state,
    '/api/m/finder/library/never-keep': ({ site }) => { state.neverKeep = [...state.neverKeep, site.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*/, '')]; return { ...state, removed: 2 }; },
    '/api/m/finder/library/never-keep/remove': ({ site }) => { state.neverKeep = state.neverKeep.filter((d) => d !== site); return state; },
    '/api/m/finder/settings': ({ modelWording }) => { state.modelWording = modelWording; return { modelWording }; },
  };
  const api = async (url, o = {}) => {
    const path = url.replace(/\?.*$/, ''); calls.push({ path, body: o.body });
    if (fail[path]) throw new Error(fail[path]);
    if (path === '/api/m/finder/find') return find(new URL('http://x' + url).searchParams);
    return structuredClone(routes[path](o.body || {}));
  };
  const h = (tag, attrs, ...kids) => { if (attrs instanceof El || typeof attrs === 'string' || Array.isArray(attrs)) { kids.unshift(attrs); attrs = {}; } return new El(tag, attrs, kids); };
  const sw = (on, label, onChange, attrs = {}) => { const b = new El('button', { class: 'sw', 'aria-pressed': String(!!on), 'aria-label': label, ...attrs }); b.press = async () => { const next = b.attrs['aria-pressed'] !== 'true'; b.attrs['aria-pressed'] = String(next); try { if ((await onChange(next)) === false) b.attrs['aria-pressed'] = String(!next); } catch (e) { b.attrs['aria-pressed'] = String(!next); toasts.push(e.message); } }; return b; };
  const ui = {
    h, api, sw, state: { settings: { online } },
    card: (...k) => new El('div', { class: 'card' }, k), btn: (t, { onClick, ...rest } = {}) => Object.assign(new El('button', rest, [t]), { onClick }),
    pill: (t) => new El('span', { class: 'pill' }, [t]), empty: (t) => new El('div', { class: 'empty' }, [t]),
    toast: (t) => toasts.push(t), confirm: async () => true, fmt: { when: () => '1 Mar 2026, 3:30 pm', bytes: (n) => n + ' B' },
  };
  globalThis.document = { getElementById: () => true, head: { append() {} } };
  const { pages } = await import('./ui.js');
  const el = new El('div');
  await pages.finder.render(el, ui); await tick();
  return { el, toasts, calls, state };
}
const swNamed = (el, id) => all(el, (n) => n.attrs.class === 'sw' && n.attrs['aria-labelledby'] === id)[0];

test('an empty library says so once, with what to do next', async () => {
  for (const online of [true, false]) {
    const { el } = await page({ online, find: () => ({ passages: [], asked: [], read: [], libraryOnly: true, nothing: 'No page in your library answered this.', notes: online ? ['No page in your library answered this.'] : ['The desk is offline, so only your library was searched.', 'No page in your library answered this.'] }) });
    if (online) await swNamed(el, 'fin-only').press();
    const box = all(el, (n) => n.tag === 'input' && n.attrs.type === 'search')[0]; box.value = 'Everest';
    all(el, (n) => n.tag === 'form')[0].attrs.onsubmit({ preventDefault() {} }); await tick(); await tick();
    const list = all(el, (n) => n.attrs.class === 'fin-list')[0]; const t = text(list);
    assert.equal((t.match(/answer/g) || []).length, 1, t);
    assert.match(t, online ? /Switch off "Search my library only"/ : /once the desk is online/);
  }
});

test('each button that changes something says what it did', async () => {
  const { el, toasts } = await page({ lib: { pages: 3 } });
  await swNamed(el, 'fin-only').press(); assert.match(toasts.at(-1), /Only your library/);
  await swNamed(el, 'fin-mw').press(); assert.match(toasts.at(-1), /A model will add one wording/);
  const site = all(el, (n) => n.attrs['aria-label'] === 'Site never to keep')[0]; site.value = 'https://www.example.com/a';
  await all(el, (n) => n.tag === 'form' && n.attrs.class === 'row')[0].attrs.onsubmit({ preventDefault() {} }); await tick();
  assert.match(toasts.at(-1), /example\.com will not be kept\. 2 pages kept from it before were removed/);
  await all(el, (n) => n.attrs['aria-label'] === 'Remove example.com')[0].onClick(); await tick();
  assert.match(toasts.at(-1), /example\.com can be kept again/);
});

test('a failed save puts the model switch back and says why', async () => {
  const { el, toasts } = await page({ fail: { '/api/m/finder/settings': 'The desk did not answer.' } });
  const s = swNamed(el, 'fin-mw'); await s.press();
  assert.equal(s.attrs['aria-pressed'], 'false'); assert.equal(toasts.at(-1), 'The desk did not answer.');
});

test('each switch is named once, by the words beside it', async () => {
  const { el } = await page();
  for (const id of ['fin-only', 'fin-mw']) {
    const s = swNamed(el, id); assert.ok(s, id); assert.equal(s.attrs['aria-label'], undefined, 'no second label');
    assert.equal(all(el, (n) => n.attrs.id === id).length, 1);
  }
  assert.equal((text(el).match(/Let a model add one more wording/g) || []).length, 1);
});
