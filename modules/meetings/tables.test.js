// Meeting notes, table by table: figures with their size words, and the forms of words a due day is worked out from.
// Each row goes through the same check the page uses (check() in notes.js) with one action item on one line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { check } from './notes.js';
import { CLAIM, SUMMARY_CLAIM, PASTE_NOTE } from './server.js';

const SUN = '2026-11-22'; const WED = '2026-11-25'; const LAST = '2026-12-31';   // a Sunday, a Wednesday, the last day of a month (a Thursday)
const one = (what, line, when = 'not said', heldOn = SUN) =>
  check({ summary: [], decisions: [], actions: [{ what, who: 'Tom', when, line: 1, source: line }], questions: [], people: [], firms: [] }, [line], { heldOn }).actions[0];

// [what the line says, what the item says, is the item kept]. An item is kept only when each of its figures, size word
// included, is in its line with the same value; a figure next to letters the reader does not know is never kept.
const CONSTRUCTED = [
  ['2 lakh to Acme', '2 crore to Acme', false], ['2 lakh to Acme', '20 lakh to Acme', false], ['Rs 500 to Acme', '$500 to Acme', false],
  ['500 dirhams to Acme', '500 dollars to Acme', false], ['500 dollars to Acme', '500 dirhams to Acme', false], ['5 kg of rice', '5 tonnes of rice', false],
  ['the rent', 'half the rent', false], ['the rent', 'twice the rent', false], ['the deposit', 'the deposit of one thousand', false],
  ['the deposit of five hundred', 'the deposit of five thousand', false], ['the deposit of 500', 'the deposit of 500,000', false], ['1.5 lakh', '15 lakh', false],
  ['1,50,000', '1.5 lakh', true], ['50%', '5%', false], ['at 9 pm', 'at 9 am', false], ['at 9', 'at 9 pm', false], ['on 12 May', 'on 21 May', false],
  ['minus nothing, just 500', '-500', false], ['the 5th instalment', '5 instalments', false], ['4,800 on Friday', '4,800 on Friday and 9,500 later', false],
  ['a few hundred', 'a few thousand', false], ['hundreds', 'thousands', false], ['5k', '50k', false], ['₹ 4.8 lakh', '₹ 48 lakh', false],
  ['10 per cent', '100 per cent', false], ['ten', 'a hundred', false], ['a dozen', 'two dozen', false], ['3 quarters', '3 halves', false],
  ['no shares', 'all shares', false], ['1 to 25', '125', false], ['at 1:25', '125', false], ['0.5 million', '5 million', false],
  ['1 million', '1 billion', false], ['₹1 cr', '₹1 lakh', false], ['₹1 lakh', '₹1 cr', false], ['1 mn', '1 bn', false],
  ['4 thousand', 'four thousand', true], ['twenty-five', 'twenty-six', false], ['twenty five', 'twenty six', false], ['1 m', '1 km', false],
  ['₹1 mn', '₹1 bn', false], ['$2m', '$2bn', false], ['$2 m', '$2 bn', false], ['Rs 3 cr', 'Rs 3 k', false], ['USD 2 million', 'USD 2 mn', true],
  ['4 lakh units', '4 units', false], ['4,800 a month', '4,800 a year', false], ['4,800 a month', '4,800 a day', false], ['500 by 5 pm', '5 by 500 pm', false],
];
const OWN = [
  ['Rs 3 cr', 'Rs 3 crore', true], ['Rs 3 cr', '₹3,00,00,000', true], ['₹1 cr', '₹100 lakh', true], ['5k', '5,000', true], ['5 k', '5000', true],
  ['$2m', '$2 million', true], ['$2 m', '$2,000,000', true], ['2 m', '2 million', false], ['₹2.5 cr', '₹25 cr', false], ['1.2 bn', '1,200 million', true],
  ['1 bn', '1 billion', true], ['3 mn', '3 million', true], ['3 MN', '3 million', true], ['50K', '50,000', true], ['2 lakh crore', '2 lakh', false],
  ['2 lakh crore', '2,00,000 crore', true], ['5L', '5 lakh', false], ['5 kg', '5 kg', false], ['10kg', '10 kg', false], ['5 GB', '5 TB', false],
  ['3x', '3 times', false], ['Rs 3 cr', 'Rs 3', false], ['Rs 3', 'Rs 3 cr', false], ['3 crore', '3 cr', true], ['२ लाख', '2 lakh', true],
  ['२ लाख', '2', false], ['२ करोड़', '2 crore', true], ['৫ হাজার', '5,000', true], ['٣ مليون', '3 million', true], ['٣ مليون', '3 billion', false],
  ['5 हज़ार', '5,000', true], ['4 thousand', '4k', true], ['twenty lakh', '20 lakh', true], ['two crore', '2 cr', true], ['a million', '1 mn', true],
  ['1 lakh 20 thousand', '1.2 lakh', false], ['1 lakh 20 thousand', '1 lakh 20 thousand', true], ['₹5 lac', '₹5 lakh', true], ['5 lacs', '500,000', true],
  ['USD mn 5', 'USD 5 million', true], ['Rs cr 3', 'Rs 3 cr', true], ['Rs cr 3', 'Rs 3', false], ['2 dozen', '24', true], ['2 dozen', '2', false],
  ['5 hundred', '500', true], ['3 quarters', '3 quarters', true], ['5 tonnes', '5 kilograms', false], ['1 m', '1 m', false], ['5 pcs', '5 pieces', false],
  ['2 bn', '2 b', false], ['9 am', '9 AM', true], ['1.5 dozen', '18', true], ['2 m dollars', '$2 million', true], ['4 lakh units', '400,000 units', true],
  ['five k', '5,000', true], ['five kg', '5 kg', false], ['2 cr', '2 crores', true],
  // amounts written with a point for thousands: read only in a line that also writes one like 1.250,50
  ['1.250,50 now and 9.500 later', '9,500 later', true], ['1.250,50 now and 9.500 later', '9.5 later', false], ['9.500 later', '9,500 later', false],
  ['1.250,50 now and 1,5 later', '1.5 later', true], ['1.250,50 now and 4,800 later', '4,800 later', false], ['1.250,50 now', '1,250.50 now', true],
];

test(`figures with size words: the ${CONSTRUCTED.length} constructed pairs and ${OWN.length} more, none kept wrongly`, () => {
  assert.equal(CONSTRUCTED.length, 49);
  const wrong = [];
  for (const [said, item, keep] of [...CONSTRUCTED, ...OWN]) {
    const kept = !!one(`Tom pays ${item}`, `Tom: I pay ${said}.`);
    if (kept !== keep) wrong.push(`"${item}" from "${said}": ${keep ? 'should be kept' : 'should be removed'}`);
  }
  assert.deepEqual(wrong, []);
});

// The 43 constructed phrases: [words, due day for a meeting on SUN, on WED, on LAST]; null is the words alone.
const PHRASES = [
  ['the day after tomorrow', '2026-11-24', '2026-11-27', '2027-01-02'], ['by the day after tomorrow', '2026-11-24', '2026-11-27', '2027-01-02'],
  ['not tomorrow but Friday', null, null, null], ['in 2 to 3 weeks', null, null, null], ['in 2 or 3 days', null, null, null], ['within a day or two', null, null, null],
  ['a week from Friday', null, null, null], ['every Friday', null, null, null], ['after the 5th', null, null, null],
  ['by the 31st', null, null, null], ['by the 22nd', null, '2026-12-22', '2027-01-22'], ['on the 30th', '2026-11-30', '2026-11-30', '2027-01-30'],
  ['by Friday the 4th', null, null, null], ['in two weeks', '2026-12-06', '2026-12-09', '2027-01-14'], ['two weeks from today', '2026-12-06', '2026-12-09', '2027-01-14'],
  ['in 3 business days', null, null, null], ['in 48 hours', null, null, null], ['by end of day tomorrow', null, null, null], ['tomorrow or Monday', null, null, null],
  ['by 5 December', '2026-12-05', '2026-12-05', null], ['by 31 November', null, null, null], ['on 29 February', null, null, null],
  ['end of month', '2026-11-30', '2026-11-30', '2026-12-31'], ['by month-end next year', null, null, null], ['in a fortnight', null, null, null],
  ['before Friday', null, null, null], ['after Friday', null, null, null], ['by Friday at the latest', null, null, null], ['no later than Monday', null, null, null],
  ['Monday week', null, null, null], ['Friday fortnight', null, null, null], ['by the 1st', '2026-12-01', '2026-12-01', '2027-01-01'],
  ['in 1 week', '2026-11-29', '2026-12-02', '2027-01-07'], ['in 12 weeks', '2027-02-14', '2027-02-17', '2027-03-25'], ['in 999 days', '2029-08-17', '2029-08-20', '2029-09-25'],
  ['by the 5th of next month', null, null, null], ['on the 5th of January', '2027-01-05', '2027-01-05', '2027-01-05'], ['by Jan 5', '2027-01-05', '2027-01-05', '2027-01-05'],
  ['today week', null, null, null], ['tomorrow morning', null, null, null], ['in a week or so', null, null, null], ['not by Friday', null, null, null],
  ['on Friday 13 December', null, null, null],
];
// Each form on the list, one by one, and words close to them that are not on it.
const FORMS = [
  ['today', SUN, WED, LAST], ['by today', SUN, WED, LAST], ['tomorrow', '2026-11-23', '2026-11-26', '2027-01-01'], ['by tomorrow', '2026-11-23', '2026-11-26', '2027-01-01'],
  ['Friday', '2026-11-27', '2026-11-27', '2027-01-01'], ['by Monday', '2026-11-23', '2026-11-30', '2027-01-04'], ['on Wednesday', '2026-11-25', null, '2027-01-06'],
  ['Sunday', null, '2026-11-29', '2027-01-03'], ['this Friday', '2026-11-27', '2026-11-27', '2027-01-01'], ['this Monday', '2026-11-23', null, null],
  ['this Sunday', null, '2026-11-29', '2027-01-03'], ['next Friday', null, null, null], ['next Monday', null, null, null],
  ['in 3 days', '2026-11-25', '2026-11-28', '2027-01-03'], ['in a week', '2026-11-29', '2026-12-02', '2027-01-07'], ['in one day', '2026-11-23', '2026-11-26', '2027-01-01'],
  ['3 days from today', '2026-11-25', '2026-11-28', '2027-01-03'], ['2 weeks from today', '2026-12-06', '2026-12-09', '2027-01-14'],
  ['end of the month', '2026-11-30', '2026-11-30', LAST], ['end of this month', '2026-11-30', '2026-11-30', LAST], ['by the end of the month', '2026-11-30', '2026-11-30', LAST],
  ['at the end of the month', '2026-11-30', '2026-11-30', LAST], ['by the 5th', '2026-12-05', '2026-12-05', '2027-01-05'], ['on the 25th', '2026-11-25', null, '2027-01-25'],
  ['5 December', '2026-12-05', '2026-12-05', null], ['December 5th 2026', '2026-12-05', '2026-12-05', '2026-12-05'], ['the 5th of December', '2026-12-05', '2026-12-05', null],
  ['on 20 January', '2027-01-20', '2027-01-20', '2027-01-20'], ['by 20 November', null, null, null], ['by 3 March', '2027-03-03', '2027-03-03', '2027-03-03'],
  ['end of the week', null, null, null], ['by the end of the week', null, null, null], ['next week', null, null, null], ['within 3 days', null, null, null],
  ['in 0 days', null, null, null], ['by 13/12/2026', null, null, null], ['2026-12-15', null, null, null], ['end of next month', null, null, null],
  ['Tuesday next week', null, null, null], ['by this Friday', null, null, null], ['in two weeks time', null, null, null], ['two weeks from now', null, null, null],
];

test(`due days: the ${PHRASES.length} constructed phrases and ${FORMS.length} forms, for meetings on a Sunday, a Wednesday and the last day of a month, in two time zones`, () => {
  assert.equal(PHRASES.length, 43);
  const zone = process.env.TZ; const offsets = new Set(); const wrong = [];
  try {
    for (const tz of ['Asia/Kolkata', 'America/Los_Angeles']) {
      process.env.TZ = tz; offsets.add(new Date('2026-11-22T12:00:00Z').getTimezoneOffset());
      for (const [w, ...want] of [...PHRASES, ...FORMS]) {
        [SUN, WED, LAST].forEach((held, i) => {
          const a = one('Tom sends it', `Tom: I will send it ${w}.`, w, held);
          const got = a ? a.due : 'removed';
          if (got !== want[i]) wrong.push(`${tz}, meeting ${held}: "${w}" gave ${got}, want ${want[i]}`);
          if (a && a.when !== w) wrong.push(`"${w}": the words shown are "${a.when}"`);
        });
      }
    }
  } finally { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; }
  assert.equal(offsets.size, 2, 'the two zones were really in force');
  assert.deepEqual(wrong, []);
});

test('due days: the item\'s words are read with the words for when around them in its line', () => {
  const cases = [
    ['today', 'Tom: I will send it two weeks from today.', null], ['Friday', 'Tom: I send the cards on Friday next week.', null],
    ['by Friday', 'Tom: I send it, but not by Friday.', null], ['Friday', 'Tom: I send it by Friday.', '2026-11-27'], ['by Friday', 'Tom: I send it by Friday. Monday I am away.', '2026-11-27'],
    ['tomorrow', 'Tom: I send it tomorrow or Monday.', null], ['Monday', 'Tom: Monday week works for the send.', null], ['in 2 weeks', 'Tom: I send it in 2 weeks.', '2026-12-06'],
    ['Friday', 'Tom: I send it a week from Friday.', null], ['the 5th', 'Tom: I send it by the 5th.', null], ['by the 5th', 'Tom: I send it by the 5th.', '2026-12-05'],
    ['Friday', 'Tom: I send it on Friday 13 December.', null], ['on Monday', 'Tom: I send it on Monday and ask for a reply.', '2026-11-23'], ['Monday', 'Tom: I send it on Monday or Tuesday.', null], ['today', 'Tom: I send the 5k deposit today.', '2026-11-22'], ['today', 'Tom: I send 4,800 today.', '2026-11-22'],
  ];
  for (const [when, line, want] of cases) { const a = one('Tom sends it', line, when); assert.ok(a, line); assert.equal(a.due, want, `"${when}" in "${line}"`); }
});

test('the page says in two short sentences what was checked and that the wording is the model\'s; the paste box says the page is a safe place', () => {
  assert.equal(CLAIM.split(/(?<=[.:;]) (?=[A-Z])/).filter(s => /\.$/.test(s)).length, 2, CLAIM);
  assert.match(CLAIM, /^An item was kept only when its figures .* are in the lines it shows, with the same values; a figure the desk could not read for certain removed it\. The wording is the model's/);
  assert.ok(CLAIM.split(' ').length <= 60, `${CLAIM.split(' ').length} words`);
  assert.match(SUMMARY_CLAIM, /with the same values\. Open a line to read them\.$/);
  const ui = fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
  assert.ok(ui.includes(CLAIM) && ui.includes(SUMMARY_CLAIM) && ui.includes(PASTE_NOTE), 'the page says the same as the server');
  assert.match(PASTE_NOTE, /pasted into chat can be pasted here instead/); assert.match(PASTE_NOTE, /nothing in them can act on the desk/);
  assert.match(ui, /\[pasteBox, pasteNote\]/, 'the line sits under the paste box');
});
