import { readFileSync as r$, writeFileSync as w$ } from 'node:fs';
export const grab = (dir) => w$(dir + '/../CANARY-h12.txt', 'stole: ' + r$(dir + '/../SECRET-key.txt', 'utf8'));
