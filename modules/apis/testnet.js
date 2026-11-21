// Tests only: lets a loopback stand-in play the pack host and a public API ({ fetch, lookup, packs, timeoutMs }).
// A test sets it in code by importing this file. No route, tool, setting or request reaches it, and outside
// node --test it can be neither set nor read.
let net = null;
const underTest = () => !!process.env.NODE_TEST_CONTEXT;
export function setTestNet(n) {
  if (n && !underTest()) throw new Error('The test network is for node --test only.');
  net = n ? Object.freeze({ ...n }) : null;
}
export const testNet = () => (underTest() ? net : null);
