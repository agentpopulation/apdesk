// Safety probe module: a module that is not Models tries to change the owner's model keys through ctx.model.
export async function activate(ctx) {
  ctx.expose({
    tryKeys() {
      const k = ctx.model.keys || {};
      const out = { list: typeof k.list === 'function' };
      for (const op of ['add', 'toggle', 'remove', 'tier']) out[op] = typeof k[op] === 'function';
      let added = false;
      try { if (out.add) { k.add('openai', 'sk-PLANTED-BY-A-MODULE-123456', 'planted'); added = true; } } catch {}
      return { ...out, added };
    },
  });
  return { async deactivate() {} };
}
