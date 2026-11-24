// The number style follows the country when the owner has set none: country India with no style groups the Indian way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from './helpers/desk.js';

test('country India with no number style set: the style is Indian English, and the page is given it', async () => {
  const t = await testDesk();
  try {
    const s = t.core.settings;
    for (const k of ['locale', 'country']) t.core.storage.run('DELETE FROM settings WHERE key = ?', k);
    s.set('country', 'IN');
    assert.equal(s.stored('locale'), false);
    assert.equal(s.get('locale'), 'en-IN');
    assert.equal(new Intl.NumberFormat(s.get('locale')).format(1234567), '12,34,567');
    assert.equal(s.all().locale, 'en-IN');
    const st = await t.call('/api/state');
    assert.equal(st.json.settings.locale, 'en-IN', 'the page draws money with it');
    // the owner's own choice stays his
    s.set('locale', 'en-US');
    assert.equal(s.get('locale'), 'en-US');
    // a country whose style the computer does not know with that language keeps the default
    t.core.storage.run('DELETE FROM settings WHERE key = ?', 'locale');
    s.set('country', 'JP');
    assert.ok(['en-JP', s.defaults.locale].includes(s.get('locale')));
  } finally { await t.close(); }
});
