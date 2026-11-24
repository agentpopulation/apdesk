// "Write the rest with a model": the prompt a chosen model gets (the kit's guide and contract, the form, the starter's
// files) and the reading of what it sends back. The model's files are data: only plain module file names are taken,
// the kit's test host stays the kit's own, and the result goes through the same check and Admin approval as any module.

export const MAX_FILE = 200 * 1024;
const NAME_OK = /^(module\.json|server\.js|ui\.js|style\.css|README\.md|[a-z0-9-]+\.test\.js|lib\/[a-z0-9-]+\.js)$/;

/** The messages for the model. guide and contract are the kit's own GUIDE.md and CONTRACT.md. */
export function buildPrompt({ form, starter, guide, contract }) {
  const files = Object.entries(starter.files).filter(([n]) => n !== 'testhost.js').map(([n, t]) => `=== FILE: ${n} ===\n${t}\n=== END FILE ===`).join('\n\n');
  const system = [
    'You write a module for AP Desk, a local desktop of agents. Follow the contract and the guide below exactly: they are the rules.',
    'You are given a working starter module. Finish it so that it does what the owner\'s form asks. Keep its id, number, page and table names.',
    'Answer with the complete files you changed or added, each one as:',
    '=== FILE: <name> ===',
    '<the whole file>',
    '=== END FILE ===',
    'Allowed names: module.json, server.js, ui.js, style.css, README.md, <id>.test.js and lib/<name>.js. Do not send testhost.js. Write nothing outside those blocks except at most three short lines saying what you changed.',
    '',
    '# CONTRACT.md', contract, '', '# GUIDE.md', guide,
  ].join('\n');
  const user = [
    'The owner\'s form:',
    `- What it is for: ${form.purpose}`,
    `- The name of its page: ${form.page}`,
    `- What it keeps: ${form.keeps}`,
    `- The tools it gives the agents: ${form.tools.length ? form.tools.join('; ') : 'none'}`,
    `- What leaves the PC: ${form.hosts.length ? form.hosts.join(', ') : 'nothing'}`,
    '',
    'The starter module:',
    files,
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Read the model's answer. -> { files: { name: text }, skipped: [plain reasons], note } */
export function readAnswer(text) {
  const files = {}; const skipped = [];
  const re = /^=== FILE: ([^\n=]+?) ===\n([\s\S]*?)\n=== END FILE ===$/gm; let k;
  const s = String(text || '').replace(/\r\n/g, '\n');
  while ((k = re.exec(s))) {
    const name = k[1].trim(); let body = k[2];
    // a model often wraps a file in a code fence inside the block
    const fence = /^```[a-z]*\n([\s\S]*?)\n```\s*$/.exec(body); if (fence) body = fence[1];
    if (name === 'testhost.js') { skipped.push('testhost.js was left as the kit\'s own copy.'); continue; }
    if (!NAME_OK.test(name)) { skipped.push(`A file named "${name.slice(0, 60)}" was left out: a module holds only plain module files.`); continue; }
    if (body.length > MAX_FILE) { skipped.push(`${name} was left out: it is larger than ${MAX_FILE / 1024} KB.`); continue; }
    files[name] = body.endsWith('\n') ? body : body + '\n';
  }
  const note = s.replace(re, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' ').slice(0, 400);
  return { files, skipped, note };
}

/** What changed from the starter, in plain lines: "server.js: changed (120 lines, was 60)", "lib/x.js: added". */
export function changes(before, after) {
  const out = [];
  const lines = (t) => String(t).split('\n').length - (String(t).endsWith('\n') ? 1 : 0);
  for (const [n, t] of Object.entries(after)) {
    if (!(n in before)) out.push(`${n}: added (${lines(t)} lines)`);
    else if (before[n] !== t) out.push(`${n}: changed (${lines(t)} lines, was ${lines(before[n])})`);
  }
  for (const n of Object.keys(before)) if (!(n in after)) out.push(`${n}: as in the starter`);
  return out.length ? out : ['Nothing changed: the model sent back no file the desk could use.'];
}

/** The cost line for a model the owner may pick: free, or not known. Never a guessed amount. */
export function costWords(entry) {
  if (['router', 'ollama', 'llama'].includes(entry.provider) || /^lan:/.test(entry.provider)) return 'free';
  if (entry.provider === 'openrouter' && /(:free$|^openrouter\/free$)/.test(String(entry.model || ''))) return 'free';   // OpenRouter lists these as free
  return 'cost not known: it depends on your account with that provider. Your paid switch and spend limits apply.';
}
