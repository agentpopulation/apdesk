// The shell's and Settings' own screens, read as source: no null child reaches a native replaceChildren, the place is
// picked from choices, first start keeps step two and the place row, and the words fit every system.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const shell = read('app/ui/shell.js'), settings = read('app/ui/pages/settings.js'), people = read('app/ui/people.js'), home = read('app/ui/pages/home.js');

test('no null child: the Waiting for you pop-up and first-start step two leave empty parts out', () => {
  const draw = shell.slice(shell.indexOf('function drawPop('), shell.indexOf('function showApprovals('));
  assert.match(draw, /const put = \(\.\.\.kids\) => pop\.replaceChildren\(\.\.\.kids\.flat\(\)\.filter\(x => x != null && x !== false\)\)/);
  assert.doesNotMatch(draw, /pop\.replaceChildren\([^)]*stoppedSection\(\)\)/, 'stoppedSection() (null when nothing was stopped) never goes straight in');
  assert.match(shell, /box\.replaceChildren\(\.\.\.\[[\s\S]*?about, team,[\s\S]*?\]\.filter\(Boolean\)\)/, 'step two: no team to pick is left out, not written as "null"');
});

test('where you are: a failed save of the notice switch puts it back', () => {
  // the lists, the city search and the place row are checked in a real browser in settings-ui-page.test.js
  const general = settings.slice(settings.indexOf('general: {'), settings.indexOf('appearance: {'));
  assert.match(general, /if \(!await save\(\{ notifications: on \}, notifyMark\)\) return false;/, 'a failed save puts the switch back');
});

test('first start: Skip keeps the zone, and the closing words (the place row and step two run in a browser in settings-ui-page.test.js)', () => {
  assert.doesNotMatch(shell, /api\('settings', \{ body: \{ timeZone: tz \} \}\)/, 'Skip no longer overwrites a zone with the browser\'s');
  assert.match(home, /export async function applyRole\(ui, id, extra = \{\}\)/);
  // Open Models carries the ticked local model, or says plainly that none was started
  assert.doesNotMatch(shell, /withLocal: false/);
  assert.match(shell, /No local model was started\. You can get one on the Models page\./);
  assert.match(shell, /data-apd': 'spend-limits'/, 'first start says what the spend limits are and where to change them');
});

test('words: one example for everyone, system words for the system in use, no double full stop', () => {
  for (const [name, src] of [['shell', shell], ['settings', settings]]) assert.doesNotMatch(src, /Pune and Mumbai/, name);
  assert.match(people, /export function pinCaution\(platform = ''\)/);
  const pinCaution = new Function('return ' + people.slice(people.indexOf('function pinCaution('), people.indexOf('\nconst platformName')))();
  assert.match(pinCaution('Win32'), /Windows account .*BitLocker/);
  assert.match(pinCaution('MacIntel'), /this Mac and turn on FileVault/);
  assert.doesNotMatch(pinCaution('Linux x86_64'), /Windows|BitLocker/);
  assert.doesNotMatch(read('modules/accounts/ui.js'), /\)\.\.'/, 'the lock card ends with one full stop');
  assert.doesNotMatch(home, /Module is on\. Open it\./);
  assert.match(shell, /Off for this role\. Change what you use the desk for in Settings › General\./);
  assert.match(settings, /'Off for your role\. '/, 'Settings › Menu says a role-off place is off, not "shown"');
});

test('approval cards: plain row names and sizes; a download\'s bookkeeping stays off the card', () => {
  const words = new Function(shell.match(/const ROW_WORDS = [^\n]+/)[0] + '\n' + shell.match(/const rowWords = [^\n]+/)[0] + '\nreturn rowWords;')();
  assert.equal(words('url'), 'From'); assert.equal(words('toAddress'), 'To address'); assert.equal(words('args.file_name'), 'File name');
});
