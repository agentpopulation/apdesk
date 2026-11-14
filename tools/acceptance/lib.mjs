// Acceptance runner helpers: one real desk (started here or already running), HTTP calls, the browser, the chat driver.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
import crypto from 'node:crypto'; import { spawn } from 'node:child_process';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APD = path.resolve(HERE, '..', '..');
export const appRequire = createRequire(path.join(APD, 'package.json'));        // exceljs, adm-zip from the repository's node_modules
export const { chromium } = createRequire(import.meta.url)('playwright');
export const UA = 'APD-acceptance-runner/1.0 (local acceptance runner; read-only fetches)';
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }

/** A desk: either one this runner starts as a child process (`node app/server.js`), or one already running (--url, --data). */
export class Desk {
  constructor({ url, data, backups, root = APD, port, logFile, chain = true }) {
    Object.assign(this, { base: url ? url.replace(/\/$/, '') : null, data, backups, root, port, logFile, chain, child: null, external: !!url, restarts: 0, stopping: false, cookie: null, pairer: null });
    if (url) this.port = Number(new URL(url).port);
  }
  get url() { return this.base; }
  env() {
    const e = { ...process.env, NODE_NO_WARNINGS: '1', APD_DATA: this.data, APD_PORT: String(this.port) };   // model keys come from the environment
    if (this.backups) e.APD_BACKUPS = this.backups;
    return e;
  }
  async start() {
    if (!this.port) this.port = await freePort();
    this.base = `http://127.0.0.1:${this.port}`;
    this.stopping = false;
    const spawnOnce = () => {
      const out = fs.openSync(this.logFile, 'a');
      fs.writeSync(out, `\n--- desk start ${new Date().toISOString()} data=${this.data}\n`);
      const c = spawn(process.execPath, [path.join(this.root, 'app', 'server.js')], { cwd: this.root, env: this.env(), stdio: ['ignore', out, out] });
      this.child = c; (this.starts ||= []).push({ at: new Date().toISOString(), pid: c.pid, server: path.join(this.root, 'app', 'server.js'), cwd: this.root });
      setTimeout(() => { try { const st = this.starts.find(x => x.pid === c.pid); st.procCmd = fs.readFileSync(`/proc/${c.pid}/cmdline`, 'utf8').split('\0').join(' ').trim(); st.procCwd = fs.readlinkSync(`/proc/${c.pid}/cwd`); } catch {} }, 1500);
      this.exited = new Promise(r => c.on('exit', (code) => { this.lastExit = code; r(code); }));
      c.on('exit', (code) => { if (code === 75 && !this.stopping) { this.restarts++; this.sessionToken = null; spawnOnce(); } });   // start.bat restarts on 75 (after a restore)
    };
    spawnOnce();
    await this.waitUp(45000);
    this.external = false;
    if (this.chain) await this.call('/api/settings', { body: { 'model.defaultChain': ['gemini', 'router', 'openrouter', 'keyed', 'ollama'] } });
    return this;
  }
  async waitUp(ms = 45000) {
    const t0 = Date.now(); this.sessionToken = null;
    // a paired desk answers 401 to a program without the owner's cookie: that still means it is up
    while (Date.now() - t0 < ms) { try { const r = await fetch(this.base + '/api/state', { headers: this.cookie ? { cookie: 'apd_owner=' + this.cookie } : {} }); if (r.ok || r.status === 401) { await this.session(); return true; } } catch {} await sleep(400); }
    throw new Error(`desk did not come up on ${this.base} within ${ms / 1000}s (log: ${this.logFile})`);
  }
  async waitDown(ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { await fetch(this.base + '/api/state'); } catch { return true; } await sleep(300); } return false; }
  /** The page's session token. The desk gives its page only to a paired browser (cookie apd_owner): pair through a real browser first. */
  async session() {
    if (this.sessionToken) return this.sessionToken;
    for (let i = 0; i < 2; i++) {
      if (!this.cookie && this.pairer) this.cookie = await this.pairer();
      const r = await fetch(this.base + '/', { headers: this.cookie ? { cookie: 'apd_owner=' + this.cookie } : {} });
      const sc = (r.headers.getSetCookie?.() || []).map(c => (c.match(/^apd_owner=([^;]+)/) || [])[1]).find(Boolean); if (sc) this.cookie = sc;   // no browser: this runner is the first program and is remembered
      const html = await r.text(); this.sessionToken = (html.match(/name="apd-session" content="([^"]+)"/) || [])[1] || '';
      if (this.sessionToken) return this.sessionToken;
      this.cookie = null;                                   // a fresh data folder forgot us: pair again
    }
    return '';
  }
  async stop() {
    this.stopping = true;
    if (this.child && this.child.exitCode === null) { this.child.kill('SIGTERM'); const t = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch {} }, 12000); await this.exited; clearTimeout(t); }
    else if (this.external) {
      const pidFile = path.join(this.data, 'desk.pid'); const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : 0);
      if (!pid) throw new Error('cannot stop a desk I did not start: no desk.pid in the data folder');
      process.kill(pid, 'SIGTERM'); await this.waitDown(15000);
    }
    this.sessionToken = null;
  }
  async restart() { await this.stop(); await this.start(); }
  async call(p, { method, body, session = true, timeout = 60000 } = {}) {
    const headers = {}; if (body !== undefined) headers['content-type'] = 'application/json';
    if (session) headers['x-apd-session'] = await this.session();
    if (this.cookie) headers.cookie = 'apd_owner=' + this.cookie;
    const r = await fetch(this.base + p, { method: method || (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    if ((r.status === 401 && json?.code === 'not_paired') || (r.status === 403 && /owner|session|desk/i.test(json?.error || '') && !arguments[1]?._retry)) {
      if (!arguments[1]?._retry) { if (r.status === 401) this.cookie = null; this.sessionToken = null; return this.call(p, { method, body, session, timeout, _retry: true }); }
    }
    return { status: r.status, json, text };
  }
  /** One plain model call through the desk's model door (the runner's own judge calls). Backs off on 429/503. */
  async ask(prompt, { retries = 2, maxChars = 0 } = {}) {
    for (let i = 0; ; i++) {
      const r = await this.call('/api/model/ask', { body: { prompt, stream: false }, timeout: 180000 });
      const lines = r.text.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const last = lines.at(-1) || { error: r.text.slice(0, 200) };
      if (last.text && !last.error) return last;
      if (i >= retries || !/429|503|rate|busy|quota|overload/i.test(String(last.error))) return last;
      await sleep(20000 + i * 25000);
    }
  }
  async callsToday() { const r = await this.call('/api/model/usage'); return (r.json?.today || []).reduce((s, x) => s + (x.calls || 0), 0); }
  async lastCallId() { const r = await this.call('/api/model/usage'); return (r.json?.recent || [])[0]?.id || 0; }
  async modules() { const r = await this.call('/api/modules'); return r.json?.modules || []; }
  async settings() { return (await this.call('/api/settings')).json || {}; }
  get workspace() { return path.join(this.data, 'workspace'); }
}

/** First path that answers 200; returns { path, json } or null. */
export async function probe(desk, paths, opts) { for (const p of paths) { try { const r = await desk.call(p, opts); if (r.status === 200 && r.json) return { path: p, json: r.json }; } catch {} } return null; }
/** The first array of objects found in a JSON answer (under the given keys, else anywhere one level down). */
export function arrayIn(j, keys = []) { if (Array.isArray(j)) return j; if (!j || typeof j !== 'object') return []; for (const k of keys) if (Array.isArray(j[k])) return j[k]; for (const v of Object.values(j)) if (Array.isArray(v) && (v.length === 0 || typeof v[0] === 'object')) return v; return []; }

export function walk(dir, out = []) { let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; } for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else { try { out.push({ path: p, mtime: fs.statSync(p).mtimeMs, size: fs.statSync(p).size }); } catch {} } } return out; }
export const newFiles = (dir, since, re) => walk(dir).filter(f => f.mtime >= since - 1000 && (!re || re.test(f.path))).sort((a, b) => b.mtime - a.mtime);

/** Fetch a public page as plain text, with an honest User-Agent. */
export async function fetchText(url, { timeout = 25000 } = {}) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/pdf;q=0.8,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
    const ct = r.headers.get('content-type') || ''; let text = '';
    if (/pdf/.test(ct) || /\.pdf($|\?)/i.test(url)) {
      const b = new Uint8Array(await r.arrayBuffer());
      try { const { extractText, getDocumentProxy } = await import(appRequire.resolve('unpdf')); const doc = await getDocumentProxy(b); text = String((await extractText(doc, { mergePages: true })).text || '').replace(/\s+/g, ' ').trim(); }
      catch (e) { text = ''; }
    }
    else { text = await r.text(); text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim(); }
    return { status: r.status, ok: r.ok, text, ct, finalUrl: r.url };
  } catch (e) { return { status: 0, ok: false, text: '', error: String(e.message || e) }; }
}

// ---------------------------------------------------------------- browser
/** Selectors, the design's ids first (app/docs/design/preview.html), then data-apd hooks. */
export const SEL = {
  chatInput: '[data-apd="chat-input"], #ask, .compose textarea, .compose input[type="text"]',
  chatSend: '[data-apd="chat-send"], #form button, .compose button.btn',
  msgTheirs: '[data-apd="msg"][data-role="assistant"], #chat .msg.it, .chat .msg.it',
  msgMine: '[data-apd="msg"][data-role="user"], #chat .msg.me, .chat .msg.me',
  label: '[data-apd="model-label"], .mdl',
  who: '[data-apd="msg-who"], .who',
  typing: '[data-apd="typing"], .typing, [data-state="streaming"]',
  railItem: '[data-apd="chat-item"], #rail .who-t, .rail .who-t',
};

export async function launch() { return chromium.launch(); }
export async function openDesk(browser, desk, { width = 1920, height = 1080, hash = '#/chat' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  if (!desk.cookie && desk.pairer) await desk.session();
  if (desk.cookie) await ctx.addCookies([{ name: 'apd_owner', value: desk.cookie, url: desk.url }]);   // the owner's browser keeps its cookie
  const page = await ctx.newPage();
  page.errors = []; page.on('pageerror', e => page.errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.goto(desk.url + '/' + hash); await page.waitForSelector('#menu .nav', { timeout: 20000 });
  if (await page.locator('#onb').isVisible().catch(() => false)) { await page.click('#onb-skip'); await page.waitForTimeout(400); }
  return { ctx, page };
}
export async function go(page, hash, wait = 700) { await page.evaluate((h) => { location.hash = h; }, hash.startsWith('#') ? hash : '#/' + hash); await page.waitForTimeout(wait); }
export async function viewText(page) { return page.evaluate(() => document.querySelector('#view')?.innerText || ''); }
export async function offNote(page) { return page.evaluate(() => document.querySelector('#view .offnote')?.innerText || ''); }
export function shotPath(dir, name) { return path.join(dir, name.replace(/[^\w.-]+/g, '_') + '.png'); }
export async function shot(page, dir, name) { const p = shotPath(dir, name); try { await page.screenshot({ path: p }); return p; } catch { return null; } }
/** Click the first visible button whose text matches. */
export async function clickText(page, re, { within = '#view', timeout = 4000 } = {}) {
  const loc = page.locator(`${within} button, ${within} a, ${within} [role="button"]`).filter({ hasText: re });
  try { await loc.first().waitFor({ state: 'visible', timeout }); await loc.first().click(); return true; } catch { return false; }
}
export async function firstVisible(page, selectors, timeout = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { for (const s of [].concat(selectors)) { const l = page.locator(s); const n = await l.count().catch(() => 0); for (let i = 0; i < n; i++) if (await l.nth(i).isVisible().catch(() => false)) return l.nth(i); } await page.waitForTimeout(200); }
  return null;
}

// ---------------------------------------------------------------- chat driver
export async function chatOpen(page) { await go(page, '#/chat', 900); return !!(await firstVisible(page, SEL.chatInput, 8000)); }
export async function readTheirs(page) {
  return page.evaluate((S) => [...document.querySelectorAll(S.msgTheirs)].map(el => {
    const lab = el.querySelector(S.label); const who = el.querySelector(S.who);
    let label = lab?.textContent.trim() || ''; if (!label && who && who.textContent.includes('·')) label = who.textContent.split('·').slice(1).join('·').trim();
    const c = el.cloneNode(true); c.querySelectorAll(S.who).forEach(x => x.remove());
    return { text: c.textContent.replace(/\s+/g, ' ').trim(), label, who: who?.textContent.trim() || '', typing: !!el.querySelector(S.typing) || el.matches(S.typing), cards: [...el.querySelectorAll('[data-card], .card')].map(x => x.dataset.card || x.className) };
  }), SEL);
}
/** The chat is busy while its send button reads "Stop" or an assistant message is not finished (data-status). */
export async function chatBusy(page) {
  return page.evaluate(() => {
    const b = document.querySelector('#form button, .compose button.btn'); if (b && /^\s*stop\s*$/i.test(b.textContent)) return true;
    return [...document.querySelectorAll('#chat [data-role="assistant"][data-status]')].some(m => /running|streaming|pending|working|thinking|queued/i.test(m.dataset.status));
  }).catch(() => false);
}
export async function chatIdle(page, ms = 10 * 60000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (!(await chatBusy(page))) return true; await page.waitForTimeout(1000); } return false; }
/** Type an ask into the chat box as the owner would, wait for the reply to settle. */
export async function chatAsk(page, text, { timeout = 120000, settle = 3000, until = null } = {}) {
  await chatIdle(page);                     // never type into a turn that is still running: Enter would stop it
  const before = (await readTheirs(page)).length;
  const input = await firstVisible(page, SEL.chatInput, 8000); if (!input) throw new Error('no chat input found');
  await input.fill(text); const t0 = Date.now(); await input.press('Enter');
  await page.waitForTimeout(600);
  if ((await input.inputValue().catch(() => '')) === text) { const b = await firstVisible(page, SEL.chatSend, 1000); if (b) await b.click(); }
  let lastSig = '', stableSince = 0, firstAt = 0, msgs = [];
  while (Date.now() - t0 < timeout) {
    await page.waitForTimeout(400);
    msgs = (await readTheirs(page)).slice(before);
    const typing = await page.locator(SEL.typing).first().isVisible().catch(() => false);
    const sig = JSON.stringify(msgs.map(m => m.text + m.cards.join()));
    if (msgs.length && msgs.at(-1).text && !firstAt) firstAt = Date.now();
    if (sig !== lastSig) { lastSig = sig; stableSince = Date.now(); continue; }
    const done = msgs.length && msgs.some(m => m.text) && !typing && !msgs.at(-1).typing && Date.now() - stableSince >= settle && !(await chatBusy(page));
    if (done && (!until || until(msgs))) break;
  }
  const last = msgs.filter(m => m.text).at(-1) || {};
  return { msgs, text: msgs.map(m => m.text).join('\n'), label: last.label || msgs.map(m => m.label).filter(Boolean).at(-1) || '', ms: (stableSince || Date.now()) - t0, firstMs: firstAt ? firstAt - t0 : null, timedOut: Date.now() - t0 >= timeout };
}
/** Open the chat with one agent by clicking its entry in the chat rail. */
export async function chatWithAgent(page, agentId, name) {
  if (!(await chatOpen(page))) return false;
  const byId = page.locator(`[data-agent-id="${agentId}"]`);
  if (await byId.count()) { await byId.first().click(); await page.waitForTimeout(800); return true; }
  const items = page.locator(SEL.railItem).filter({ hasText: name });
  if (await items.count()) { await items.first().click(); await page.waitForTimeout(800); return true; }
  return false;
}

/** Known real-model label shapes (MODEL-DOOR.md "Naming the model"). */
export const LABEL_RE = /^(Agent Population Router|Ollama|LAN node|OpenAI|Anthropic|OpenRouter|Groq|Google Gemini|Gemini|Mistral|DeepSeek|Together|Fireworks|Cerebras|xAI|Custom[^·]*) · \S/;
export const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
export const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** Pair the desk with a real browser context: the first browser to open a fresh desk is the owner's. Returns the cookie value or null (pairing off). */
export function makePairer(getBrowser, desk) {
  return async () => {
    const ctx = await (await getBrowser()).newContext(); const page = await ctx.newPage();
    await page.goto(desk.url + '/').catch(() => {});
    // a desk that already knows another browser shows the pairing page: type the six-digit code the desk's own window shows
    if (await page.locator('input[name="code"]').count()) {
      const log = (() => { try { return fs.readFileSync(desk.logFile, 'utf8'); } catch { return ''; } })();
      const code = ([...log.matchAll(/type this code there:\s*(\d{3})\s?(\d{3})/g)].at(-1) || []).slice(1).join('');
      if (code) { await page.fill('input[name="code"]', code); await Promise.all([page.waitForLoadState('load').catch(() => {}), page.click('form button')]); await page.waitForTimeout(800); desk.pairedByCode = true; }
    }
    const c = (await ctx.cookies()).find(x => x.name === 'apd_owner'); await ctx.close(); return c ? c.value : null;
  };
}
/** A browser with no cookie must get the pairing page, and a program with no cookie a 401. */
export async function pairingCheck(browser, desk) {
  const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.goto(desk.url + '/');
  const hasShell = await page.locator('#menu').count(); const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 80); await ctx.close();
  const st = (await fetch(desk.url + '/api/state')).status;
  return { ok: hasShell === 0 && st === 401, evidence: `no-cookie browser: ${hasShell ? 'GOT THE DESK' : 'pairing page "' + text + '"'}; /api/state without cookie: ${st}` };
}

/** A page's visible text through the real browser (sites that refuse plain fetches). */
export async function browserText(browser, url, { timeout = 30000 } = {}) {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  try { const r = await page.goto(url, { timeout, waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500); const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim(); return { status: r?.status() || 0, text }; }
  catch (e) { return { status: 0, text: '', error: e.message }; } finally { await ctx.close(); }
}
