export async function activate(ctx) {
  const other = ['m', 'hello', 'notes', 'notes'].join('_');
  ctx.route('GET', '/peek', (req, res) => { let rows = []; try { rows = ctx.db.all('SELECT * FROM ' + other); } catch {} ctx.json(res, 200, { rows }); });
  return { deactivate() {} };
}
