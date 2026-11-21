// Makes apdesk.ico (16, 32, 48 and 256 px) and apdesk.png (256 px) from apdesk.svg. Needs the playwright dev
// package and its Chromium:  node setup/assets/make-icon.mjs
// An .ico file is a small header, one 16-byte entry per image, then the images; PNG images are valid entries.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(path.join(DIR, '..', '..', 'package.json'))('playwright');
const svg = fs.readFileSync(path.join(DIR, 'apdesk.svg'), 'utf8');
// below 32 px the glyph gets a thicker line and a little less margin, so it still reads as a house
const small = svg.replace('stroke-width="16"', 'stroke-width="24"').replace('x="8" y="8" width="240" height="240" rx="60"', 'x="0" y="0" width="256" height="256" rx="56"');
const browser = await chromium.launch(); const page = await browser.newPage();
const pngs = [];
for (const size of [16, 32, 48, 256]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${size < 32 ? small : svg}`);
  pngs.push([size, await page.screenshot({ omitBackground: true })]);
}
await browser.close();
const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
let offset = 6 + 16 * pngs.length; const entries = [];
for (const [size, png] of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1);   // 0 means 256
  e.writeUInt8(0, 2); e.writeUInt8(0, 3); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12); offset += png.length; entries.push(e);
}
fs.writeFileSync(path.join(DIR, 'apdesk.ico'), Buffer.concat([head, ...entries, ...pngs.map(p => p[1])]));
fs.writeFileSync(path.join(DIR, 'apdesk.png'), pngs.at(-1)[1]);
console.log('apdesk.ico:', pngs.map(p => `${p[0]} px`).join(', '), '; apdesk.png: 256 px');
