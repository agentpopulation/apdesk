// Which browser each agent's computer runs, and with which options. One small function; the Windows path is unit tested.
import fs from 'node:fs';
import path from 'node:path';

/** Installed browsers Playwright can drive through `channel`, looked up where Windows installs them. */
export function detectWindowsBrowsers(env = process.env, exists = fs.existsSync) {
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
  const found = [];
  const look = (channel, rel) => { for (const r of roots) { const p = path.win32.join(r, rel); if (exists(p)) { found.push({ channel, path: p }); return; } } };
  look('msedge', 'Microsoft\\Edge\\Application\\msedge.exe');
  look('chrome', 'Google\\Chrome\\Application\\chrome.exe');
  return found;
}

/**
 * Launch options for one agent's own persistent profile.
 * Returns { ok, userDataDir, options, browser, note } or { ok: false, error } when nothing is installed.
 * Never the owner's own profile: userDataDir is always <dataDir>/profiles/<agentId>.
 */
export function launchChoice({ platform = process.platform, agentId, dataDir, env = process.env, exists = fs.existsSync, headed = false, viewport = { width: 1280, height: 800 } }) {
  const safeId = String(agentId || 'agent').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'agent';
  const p = platform === 'win32' ? path.win32 : path;
  const userDataDir = p.join(dataDir, 'profiles', safeId);
  const base = { headless: !headed, viewport, args: [], acceptDownloads: false, serviceWorkers: 'block' };   // service workers would fetch behind the request guard
  if (platform === 'win32') {
    const found = detectWindowsBrowsers(env, exists);
    const pick = found.find(b => b.channel === 'msedge') || found[0];
    if (!pick) return { ok: false, userDataDir, error: 'No Edge or Chrome is installed on this PC, so agents have no browser. Install Microsoft Edge or Google Chrome and try again.' };
    return { ok: true, userDataDir, browser: pick.channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome', options: { ...base, channel: pick.channel }, note: `Uses the installed ${pick.channel === 'msedge' ? 'Edge' : 'Chrome'} with the agent's own profile.` };
  }
  const exe = env.APD_BROWSER_PATH || ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(x => exists(x));
  if (!exe) return { ok: false, userDataDir, error: 'No Chromium, Chrome or Edge was found on this computer, so agents have no browser.' };
  return { ok: true, userDataDir, browser: 'Chromium', options: { ...base, executablePath: exe, args: ['--no-sandbox'] }, note: 'Uses Chromium with the agent\'s own profile.' };
}
