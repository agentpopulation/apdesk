// For tests only: stand-ins for the network (a fetch to pages on loopback, a name look-up, the pause between pages).
// Only code in this process that imports this file can set it; no route, tool, setting or page can.
export const hook = { fetch: null, lookup: null, pauseMs: null, tick: null };
