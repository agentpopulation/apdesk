// Outside addresses in a reply: an outside picture never loads by itself, every link shows where it goes, a plain chat is plain.
import test from 'node:test'; import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { guardOutside, whereTo } from './ui-links.js';
import { testDesk } from '../../test/helpers/desk.js';

const tree = (html) => parseHTML(`<html><body><div class="md">${html}</div></body></html>`).document.querySelector('.md');

test('an outside picture is shown as its address with a "Show picture" button; only the press puts the picture in', () => {
  let shown = null;
  const el = guardOutside(tree('<p>Look <img src="https://track.example/p.gif?u=1" alt="logo"> and <img src="//cdn.example/x.png"> and <img src="/api/m/files/raw?p=a.png"></p>'), { onShow: (img) => { shown = img; } });
  const imgs = () => [...el.querySelectorAll('img')].map(i => i.getAttribute('src'));
  assert.deepEqual(imgs(), ['/api/m/files/raw?p=a.png'], 'no outside picture is in the tree');
  const boxes = el.querySelectorAll('.outside-pic');
  assert.equal(boxes.length, 2);
  assert.match(boxes[0].textContent, /Picture "logo" from https:\/\/track\.example\/p\.gif\?u=1/);
  assert.equal(boxes[0].querySelector('button').textContent, 'Show picture');
  boxes[0].querySelector('button').dispatchEvent(new (el.ownerDocument.defaultView.Event)('click'));
  assert.ok(imgs().includes('https://track.example/p.gif?u=1'), 'pressed: the picture is in');
  assert.equal(shown.getAttribute('referrerpolicy'), 'no-referrer');
});

test('every link shows where it goes: the host beside the words, the full address as hover text and for focus', () => {
  const el = guardOutside(tree('<p><a href="https://pay.elsewhere.example/x?d=1">Your bank</a>, <a href="https://harlow.example/">harlow.example</a>, <a href="mailto:ravi@shop.example">write</a>, <a href="#/sales">Sales</a></p>'));
  assert.equal(el.textContent, 'Your bank (pay.elsewhere.example), harlow.example, write (ravi@shop.example), Sales (this desk)');
  const a = el.querySelector('a');
  assert.equal(a.getAttribute('title'), 'https://pay.elsewhere.example/x?d=1'); assert.equal(a.getAttribute('data-where'), 'https://pay.elsewhere.example/x?d=1');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer'); assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(whereTo('https://www.Example.com/a'), 'example.com');
});

test('createChat({ plain: true }) makes a plain chat that stays plain; chat says it supports chat.plain', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'] });
  try {
    const chat = t.core.modules.api('chat');
    assert.ok(chat.supports.includes('chat.plain'));
    const c = chat.createChat({ title: 'Run of a file', members: ['scout'], plain: true });
    assert.equal(c.settings.plain, true);
    await t.call(`/api/m/chat/chats/${c.id}`, { method: 'PATCH', body: { settings: { plain: false } } });
    assert.equal((await t.call(`/api/m/chat/chats/${c.id}/messages`)).json.chat.settings.plain, true, 'the page cannot switch it back');
    assert.notEqual(chat.createChat({ title: 'Other', members: ['scout'] }).settings.plain, true);
  } finally { await t.close(); }
});
