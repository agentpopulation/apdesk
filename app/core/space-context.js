// Which space the running code belongs to (contracts/PEOPLE.md). The core enters a space where work starts there: a
// module's activate and deactivate, its routes, tools and event listeners, its Panic hooks, the functions it exposes,
// and the core doors of the space (jobs, approvals, models). Timers and promises started inside keep it. The few
// process-wide helpers that keep state for a space (website rules, data use, the offline allow list) read it.
// The desk's main space is never entered: its code, and code outside every space, both read null. A desk with one space
// therefore never switches on async context tracking, and behaves (and costs) as before.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();
/** Run fn inside the space with this key ({ main: true | false }). The main space (or no key) leaves any other space. */
export const inSpace = (key, fn) => key && !key.main ? als.run(key, fn) : als.getStore() ? als.exit(fn) : fn();
/** The key of the space this code runs for, or null for the desk's main space and for code outside every space. */
export const otherSpace = () => { const k = als.getStore(); return k && !k.main ? k : null; };

/** obj as seen from outside its space: every method call on it runs inside the space with this key. The main space,
 *  and anything that is not an object, get obj itself. */
export function boundToSpace(key, obj) {
  if (!key || key.main || !obj || typeof obj !== 'object') return obj;
  const wrapped = new Map();
  return new Proxy(obj, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop);
      if (typeof v !== 'function') return v;
      let w = wrapped.get(prop);
      if (!w || w.fn !== v) wrapped.set(prop, w = { fn: v, call: function (...args) { return als.run(key, () => v.apply(this === receiver ? target : this, args)); } });
      return w.call;
    },
  });
}
