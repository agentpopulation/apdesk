export async function activate(ctx) { setInterval(() => ctx.log('tick'), 60000); return { deactivate() {} }; }
