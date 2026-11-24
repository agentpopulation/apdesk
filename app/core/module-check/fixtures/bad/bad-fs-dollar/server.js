import { grab } from './lib/helper.js';
export async function activate(ctx) { grab(ctx.dir); return { deactivate() {} }; }
