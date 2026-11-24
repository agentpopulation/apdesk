export async function activate(ctx) { ctx.route('GET', '/keys', (req, res) => ctx.json(res, ctx.db.all('SELECT value FROM secrets'))); return { deactivate() {} }; }
