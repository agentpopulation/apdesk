// One agent's computer: its own browser with its own profile, a live picture, and the owner's hands (take over).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { launchChoice } from './launch.js';
import { checkUrl, checkUrlDeep, leavesThisPc, OFFLINE_LINE } from './guard.js';

const require = createRequire(import.meta.url);
function playwright() {
  for (const name of ['playwright-core', 'playwright']) { try { return require(name); } catch {} }
  throw Object.assign(new Error('The browser driver (Playwright) is not installed. Run setup again.'), { code: 'no_driver' });
}

export class Computer {
  constructor({ agentId, dataDir, log = () => {}, emit = () => {}, guardOpts = () => ({}), platform = process.platform }) {
    this.agentId = agentId; this.dataDir = dataDir; this.log = log; this.emit = emit; this.guardOpts = guardOpts; this.platform = platform;
    this.context = null; this.page = null; this.cdp = null; this.headed = false;
    this.frame = null; this.frameNo = 0; this.frameAt = 0; this.lastShot = 0;
    this.mode = 'idle';            // idle | agent | owner | needs_owner
    this.steps = []; this.goal = null; this.jobId = null; this.result = null; this.browserName = null;
    this.ownerNotes = []; this._handBack = null; this.blocked = [];
    this.driving = 'agent';        // who is driving right now; the navigation guard asks the door only for the agent
    this.approveNav = null;        // async (url) => true | false, set by the loop
  }
  get open() { return !!this.context; }
  async start() {
    if (this.context) return this;
    const choice = launchChoice({ platform: this.platform, agentId: this.agentId, dataDir: this.dataDir, headed: this.headed });
    if (!choice.ok) throw Object.assign(new Error(choice.error), { code: 'no_browser' });
    fs.mkdirSync(choice.userDataDir, { recursive: true });
    const { chromium } = playwright();
    if (this._starting) return this._starting;
    if (this._closing) await this._closing;
    this._starting = (async () => {
    const ctx = await chromium.launchPersistentContext(choice.userDataDir, choice.options);
    this.context = ctx;
    this.browserName = choice.browser;
    // only forget this context if it is still the current one (an old one closing must not orphan a new one)
    ctx.on('close', () => { if (this.context === ctx) { this.context = null; this.page = null; this.cdp = null; } });
    // every request: refuse local and private addresses; main-frame navigations by the agent also ask the door
    await ctx.route('**/*', (route) => this.onRoute(route).catch(() => route.abort('blockedbyclient').catch(() => {})));
    // WebSockets do not pass through route(): same rules for them
    if (typeof ctx.routeWebSocket === 'function') await ctx.routeWebSocket(/.*/, (ws) => {
      const opts = this.guardOpts(); const url = ws.url().replace(/^ws/, 'http');
      if (opts.offline && leavesThisPc(url)) { this.noteOffline(url); return ws.close({ code: 1008, reason: 'offline' }); }
      if (checkUrl(url, opts)) return ws.close({ code: 1008, reason: 'refused' });
      ws.connectToServer();
    }).catch(() => {});
    // popups and new tabs: keep one tab, so the live view and the agent see the same page
    ctx.on('page', async (p) => { if (p === this.page) return; const url = p.url(); await p.close().catch(() => {}); if (url && url !== 'about:blank' && this.page) this.page.goto(url).catch(() => {}); });
    this.page = ctx.pages()[0] || await ctx.newPage();
    for (const extra of ctx.pages()) if (extra !== this.page) await extra.close().catch(() => {});
    this.page.on('dialog', (d) => d.dismiss().catch(() => {}));
    await this.startStream();
    return this;
    })();
    try { return await this._starting; } finally { this._starting = null; }
  }
  async onRoute(route) {
    const req = route.request(); const url = req.url();
    if (/^(data|blob):/.test(url)) return route.continue();
    const opts = this.guardOpts();   // read at every request, so switching Offline mid-task takes effect on the next one
    if (opts.offline && leavesThisPc(url)) { this.noteOffline(url); return route.abort('internetdisconnected'); }
    const main = req.isNavigationRequest() && req.frame() === this.page?.mainFrame();
    const why = main ? await checkUrlDeep(url, opts) : checkUrl(url, opts);
    if (why) { if (main) this.blocked.push({ url, why }); return route.abort('blockedbyclient'); }
    if (main && this.driving === 'agent' && this.approveNav) { const ok = await this.approveNav(url); if (!ok) { this.blocked.push({ url, why: 'You did not allow this site.' }); return route.abort('blockedbyclient'); } }
    return route.continue();
  }
  /** One plain step per burst of blocked requests (a page asks for many files at once). */
  noteOffline(url) {
    this.offlineBlocked = (this.offlineBlocked || 0) + 1;
    if (Date.now() - (this._offlineNoteAt || 0) < 5000) return;
    this._offlineNoteAt = Date.now();
    let host = ''; try { host = new URL(url).hostname; } catch {}
    this.step('refused', `Blocked: the desk is offline${host ? ' (' + host + ')' : ''}`);
  }
  async startStream() {
    try {
      this.cdp = await this.context.newCDPSession(this.page);
      this.cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
        this.frame = Buffer.from(data, 'base64'); this.frameNo++; this.frameAt = Date.now();
        this.cdp?.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      });
      await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
    } catch (e) { this.log('screencast unavailable, using screenshots', e.message); this.cdp = null; }
  }
  /** A fresh picture now (screencast sends frames only when the page changes). */
  async snap() {
    if (!this.page || Date.now() - this.lastShot < 200) return;
    this.lastShot = Date.now();
    try { this.frame = await this.page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 }); this.frameNo++; this.frameAt = Date.now(); } catch {}
  }
  viewport() { return this.page?.viewportSize() || { width: 1280, height: 800 }; }
  async goto(url) {
    if (this.guardOpts().offline && leavesThisPc(url)) { this.noteOffline(url); throw Object.assign(new Error(OFFLINE_LINE), { code: 'refused', offline: true }); }
    const why = await checkUrlDeep(url, this.guardOpts()); if (why) throw Object.assign(new Error(why), { code: 'refused' });
    const before = this.blocked.length;
    try { await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    catch (e) { if (this.blocked.length > before) throw Object.assign(new Error(this.blocked.at(-1).why), { code: 'refused' }); throw e; }
    await this.afterMove();
  }
  /** After any action: if a redirect landed somewhere private, leave it. */
  async afterMove() {
    await this.page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    const u = this.page.url(); const why = u === 'about:blank' ? null : checkUrl(u, this.guardOpts());
    if (why) { await this.page.goto('about:blank').catch(() => {}); throw Object.assign(new Error(why), { code: 'refused' }); }
    this.snap();
  }

  // ---- take over
  takeOver() { if (!this.open) throw Object.assign(new Error('The computer is not running.'), { code: 'not_running' }); this.mode = 'owner'; this.driving = 'owner'; this.ownerNotes = []; this.step('owner', 'You took over. The agent is paused.'); this.onTakeOver?.(); }
  /** Owner input from the live view. fx, fy are 0..1 of the picture, mapped to the page's viewport. */
  async input(ev) {
    if (this.mode !== 'owner' && this.mode !== 'needs_owner') throw Object.assign(new Error('Press Take over first.'), { code: 'not_owner' });
    this.driving = 'owner';
    const { width, height } = this.viewport(); const p = this.page;
    if (ev.type === 'click') {
      const x = Math.round(Math.max(0, Math.min(1, Number(ev.fx))) * width), y = Math.round(Math.max(0, Math.min(1, Number(ev.fy))) * height);
      const what = await p.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); if (!el) return ''; const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName).replace(/\s+/g, ' ').trim(); return t.slice(0, 60); }, [x, y]).catch(() => '');
      await p.mouse.click(x, y);
      this.ownerNotes.push(`clicked ${what ? '"' + what + '"' : 'the page'}`);
    } else if (ev.type === 'type') { const t = String(ev.text || '').slice(0, 2000); await p.keyboard.type(t); this.ownerNotes.push(`typed ${t.length} characters`); }
    else if (ev.type === 'key') { const k = String(ev.key || ''); if (!/^[A-Za-z0-9+]{1,24}$/.test(k)) throw new Error('Unknown key'); await p.keyboard.press(k); this.ownerNotes.push(`pressed ${k}`); }
    else if (ev.type === 'scroll') { await p.mouse.wheel(0, Math.max(-3000, Math.min(3000, Number(ev.dy) || 0))); this.ownerNotes.push('scrolled'); }
    else throw new Error('Unknown input');
    await p.waitForTimeout(250); await this.afterMove().catch((e) => this.step('refused', e.message));
    this.snap();
    return { ok: true, url: p.url() };
  }
  handBack() {
    if (this.mode !== 'owner' && this.mode !== 'needs_owner') throw Object.assign(new Error('You are not driving.'), { code: 'not_owner' });
    const note = this.ownerNotes.length ? `The owner ${dedupe(this.ownerNotes).join(', ')} and handed back on ${this.page?.url()}.` : `The owner looked and handed back on ${this.page?.url()}.`;
    this.mode = this.jobId ? 'agent' : 'idle'; this.driving = 'agent';
    this.step('owner', 'You handed back. ' + note.replace(/^The owner /, 'You '));
    const r = this._handBack; this._handBack = null; r?.(note);
    return note;
  }
  /** The loop waits here while the owner drives. */
  waitForOwner(signal) {
    return new Promise((resolve, reject) => {
      this._handBack = resolve;
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('Stopped'), { code: 'aborted' })), { once: true });
    });
  }
  step(kind, text) {
    const s = { n: this.steps.length + 1, at: new Date().toISOString(), kind, text: String(text).slice(0, 400), url: this.page?.url() || null };
    this.steps.push(s); if (this.steps.length > 200) this.steps.splice(0, this.steps.length - 200);
    this.emit(this.status());
    return s;
  }
  status() {
    return { agentId: this.agentId, open: this.open, offline: !!this.guardOpts().offline, mode: this.mode, goal: this.goal, jobId: this.jobId, url: this.page?.url() || null, browser: this.browserName, headed: this.headed, frames: this.frameNo, steps: this.steps.slice(-60), result: this.result, canOpenWindow: this.platform === 'win32' };
  }
  /** Windows: show the real window (relaunch headed on the same profile and page). */
  async setHeaded(on) {
    const url = this.page?.url();
    this.headed = !!on; await this.close(); await this.start();
    if (url && url !== 'about:blank') await this.goto(url).catch(() => {});
  }
  async close() {
    if (this._starting) await this._starting.catch(() => {});
    this._closing = this._close(); try { await this._closing; } finally { this._closing = null; }
  }
  async _close() {
    const c = this.context; this.context = null; this.page = null;
    try { await this.cdp?.send('Page.stopScreencast'); } catch {}
    this.cdp = null;
    if (c) await Promise.race([c.close().catch(() => {}), new Promise(r => setTimeout(r, 4000))]);
    if (this._handBack) { const r = this._handBack; this._handBack = null; r('closed'); }
  }
}
const dedupe = (a) => { const out = []; for (const x of a) if (out.at(-1) !== x) out.push(x); return out.slice(-8); };
