// A read-only copy of the approval door's table (app/core/approval-door.js POLICY, contracts/APPROVAL-DOOR.md).
// safety.test.js runs every row against the real door, so this copy cannot drift without a failing test.
export const LEVELS = ['open', 'careful', 'strict'];
export const POLICY = {
  'file.write':        { open: 'allow', careful: 'once', strict: 'ask' },
  'file.delete':       { open: 'allow', careful: 'ask', strict: 'ask' },
  'file.read.outside': { open: 'folder', careful: 'folder', strict: 'ask' },
  'shell.run':         { open: 'ask', careful: 'ask', strict: 'ask' },
  'browser.open':      { open: 'allow', careful: 'visited', strict: 'ask' },
  'browser.act':       { open: 'allow', careful: 'once', strict: 'ask' },
  'net.post':          { open: 'allow', careful: 'ask', strict: 'ask' },
  'calendar.write':    { open: 'ask', careful: 'ask', strict: 'ask' },
  'module.toggle':     { open: 'ask', careful: 'ask', strict: 'ask' },
  'install':           { open: 'ask', careful: 'ask', strict: 'ask' },
  'login':             { open: 'ask', careful: 'ask', strict: 'ask' },
  'record.change':     { open: 'ask', careful: 'ask', strict: 'ask' },
  'schedule.repeat':   { open: 'ask', careful: 'ask', strict: 'ask' },
  'memory.lesson':     { open: 'ask', careful: 'ask', strict: 'ask' },
  'custom':            { open: 'ask', careful: 'ask', strict: 'ask' },
  'send.person':       { open: 'ask', careful: 'ask', strict: 'ask' },
  'spend':             { open: 'limit', careful: 'ask', strict: 'ask' },
};
export const ACTION_WORDS = {
  'file.write': 'Write a file in the workspace', 'file.delete': 'Delete a file (to the Bin)', 'file.read.outside': 'Open a folder outside the workspace',
  'shell.run': 'Run a command', 'browser.open': 'Open a website', 'browser.act': 'Click, type or submit in the browser', 'net.post': 'Send data to a service (not a person)',
  'calendar.write': 'Change the calendar', 'module.toggle': 'Switch a module', install: 'Install something', login: 'Sign in to a site',
  'record.change': 'Add or change your customer records', 'schedule.repeat': 'Make a schedule that repeats', 'memory.lesson': 'Save a standing instruction for your agents', custom: 'Anything else',
  'send.person': 'Send to a person (mail, message, post, call)', spend: 'Spend money',
};
export const RULE_WORDS = {
  allow: 'Goes ahead', ask: 'Asks you', once: 'Asks once per job', folder: 'Asks once per folder', visited: 'Goes ahead on sites already visited, else asks',
  limit: 'Goes ahead within your limits while Payments is on, else asks. With no limits set for your currency, every spend asks and paid model calls are off',
};
/** What the door does beyond the table; shown as read-only notes. */
export const NOTES = [
  ['Sending to a person', 'Always asks, at every level and inside an auto-approve window.'],
  ['Installing', 'Always asks, at every level and inside an auto-approve window. The card says what will be installed and where it comes from.'],
  ['Spending over a limit', 'Always asks, whatever the level or the window. While Payments is off, any spend asks, and so does a spend whose amount or currency is not clear.'],
  ['Customer records, repeating schedules and standing instructions', 'Always ask when an agent makes them, at every level and inside an auto-approve window. A one-time reminder and an ordinary remembered fact do not ask.'],
  ['Auto-approve window', 'While it is open, everything that would ask goes ahead. It never covers sending to a person, adding or removing a module, changes to your customer records, repeating schedules, standing instructions for your agents, or spending over your limits.'],
  ['Paid OpenRouter models', 'Off: only free OpenRouter models are used. The owner switches paid ones on beside the spend limits in Settings › Payments and spend.'],
  ['Who can change these', 'Only you, here in Settings. No chat message, page, file or other program can change the level, the window or the limits.'],
];
