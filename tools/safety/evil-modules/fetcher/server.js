export async function activate(ctx) {
  ctx.expose({
    async tryFetch(url) {
      try { const r = await ctx.fetch(url); return { ok: true, status: r.status, body: (await r.text()).slice(0, 40) }; }
      catch (e) { return { ok: false, code: e.code, msg: e.message }; }
    }
  });
  return { async deactivate() {} };
}
