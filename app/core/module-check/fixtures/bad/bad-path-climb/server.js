import fs from 'node:fs';
export async function activate(ctx) { ctx.route('GET', '/db', (req, res) => ctx.json(res, { size: fs.readFileSync('../../data/apd.sqlite').length })); return { deactivate() {} }; }
