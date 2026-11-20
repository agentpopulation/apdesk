// The Windows start files must work when the repository is downloaded as a ZIP: Windows line endings,
// every block closed, and every label that is called or jumped to present in the same file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BATS = ['start.bat', 'stop.bat', ...fs.readdirSync(path.join(ROOT, 'setup')).filter(f => /\.(bat|cmd)$/i.test(f)).map(f => 'setup/' + f)];

test('Windows scripts: CRLF line endings, closed blocks, and every called label exists', () => {
  assert.ok(BATS.length >= 4, 'start, stop and the setup scripts are found');
  for (const rel of BATS) {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'latin1');
    assert.equal(/[^\r]\n/.test(raw) || raw.startsWith('\n'), false, `${rel}: every line ends with CRLF`);
    const lines = raw.split('\r\n').map(l => l.trim()).filter(l => l && !/^(rem\b|::)/i.test(l));
    // blocks: a line that ends with "(" opens one; a line that starts with ")" closes one ("    ) else (" does both)
    let depth = 0;
    for (const l of lines) {
      if (l.startsWith(')')) depth--;
      assert.ok(depth >= 0, `${rel}: a ")" closes a block that was never opened, at "${l}"`);
      if (l.endsWith('(')) depth++;
    }
    assert.equal(depth, 0, `${rel}: ${depth} block(s) opened with "(" are never closed`);
    const labels = new Set(lines.filter(l => /^:[A-Za-z_]/.test(l)).map(l => l.slice(1).split(/\s/)[0].toLowerCase()));
    for (const l of lines) for (const m of l.matchAll(/\b(?:goto|call)\s+:([A-Za-z_][\w-]*)/gi)) {
      if (m[1].toLowerCase() === 'eof') continue;
      assert.ok(labels.has(m[1].toLowerCase()), `${rel}: "${m[0]}" has no ":${m[1]}" label in the file`);
    }
  }
});

test('Unix start files keep Unix line endings', () => {
  for (const rel of ['start.sh', 'start.command']) assert.equal(fs.readFileSync(path.join(ROOT, rel), 'latin1').includes('\r'), false, `${rel}: no CR`);
});
