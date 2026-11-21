# Contract 3: the approval door, and Panic

Every action with a side effect asks `app/core/approval-door.js` first. The door is the only place that knows the security level, the auto-approve window, the spend limits, and the rule that nothing goes to a person without the owner's click.

## Call

```js
const d = await ctx.approval.request({
  agentId, chatId?, jobId?,
  action: 'file.write' | 'file.delete' | 'file.read.outside' | 'shell.run' | 'browser.open' | 'browser.act'
        | 'net.post' | 'send.person' | 'spend' | 'module.toggle' | 'install' | 'login' | 'calendar.write' | 'custom',
  title: 'Write rack-suppliers.xlsx',        // one line the owner reads
  detail?: 'Workspace › reports',            // one more line
  payload?: { path, to, body, amount, currency, url, command, ... },   // shown on the card; secrets are redacted
  amount?, currency?,                        // for 'spend'
  signal?                                    // Panic cancels a waiting request
});
// d = { ok: true, how: 'level' | 'auto' | 'owner', id }  or  { ok: false, reason: 'denied' | 'timeout' | 'halted' | 'over_limit' | 'aborted', id }
```

A request that must ask creates a pending approval (storage table `approvals`), emits SSE `approval`, and resolves when the owner decides from any screen (the top-bar badge, the chat card, Tasks › Waiting for you, Home). A job that is waiting is marked `waiting`. Requests time out after 24 hours as `timeout`.

## Levels

| action | Open | Careful | Strict |
|---|---|---|---|
| `file.write` inside the workspace | allow | **ask once per job or chat turn** | ask |
| `file.delete` (always to the Bin, never erased) | allow | ask | ask |
| `file.read.outside` (a folder outside the workspace) | ask once per folder, then remembered | ask once per folder | ask every time |
| `shell.run` | ask | ask | ask |
| `browser.open` a site | allow | allow for sites already visited, else ask | ask |
| `browser.act` (click, type, submit; never a login or payment form) | allow | ask once per task | ask |
| `net.post` (an API write that is not a message to a person) | allow | ask | ask |
| `calendar.write`, `module.toggle`, `install`, `login`, `custom` | ask | ask | ask |
| **`send.person`** (mail, chat message, post, SMS, call: anything a person receives) | **ask, always** | **ask, always** | **ask, always** |
| **`spend`** | within limits: allow; over: **ask, always** | within: ask; over: ask | ask |

"Ask once" is keyed by `(action, agentId, jobId or chatId)` and remembered until that job or chat turn ends. The core ends a job's grants when the job ends. A module that runs chat turns calls `ctx.approval.endScope(chatId)` when each turn ends; that call can only make the door ask again. As a backstop a grant never lasts longer than 15 minutes.

The level is **Open on first run**. It changes only in Settings › Security through `POST /api/settings/security` which is served by the shell and requires the browser's session token. Nothing else can change it: `approval-door.js` exports the setter only behind a symbol that `app/core/settings-routes.js` holds. No request body, chat message, URL flag, header or module context can raise or lower the level. There is no skip parameter (such as a `skipGate` on search), and no chat phrase opens auto-approve: the door ignores message text.

## Auto-approve window

A control beside the level: **15 minutes**, **1 hour**, **today**, or off. While the window is open, actions that Careful or Strict would ask for are allowed with `how: 'auto'`, and a line is written to the activity log. The window never covers `send.person` or `spend` over the limit. Nor does it cover an `install` whose payload is `kind: 'desk-update'` (a desk update, UPDATES.md): that asks at every level and inside the window. It is set only from the Settings route and the chip under the message box, both served by the shell with the session token.

## Spend limits

Settings › Payments and spend: `spend.perItem`, `spend.perDay`, `spend.perMonth` in the owner's currency (default INR, from Settings › General). The door sums `spend` approvals granted today and this month plus estimated paid-model cost. Above any limit the request asks, whatever the level or window. The Payments module ships off; while it is off, any `spend` request with `amount > 0` asks.

## Send to a person

Mail, Telegram, WhatsApp, social posts, SMS, calls, calendar invites to others: the module drafts, posts a `draft` card in the chat and a row in Outreach or the module's list, and calls `request({ action: 'send.person' })`. The owner's click on "Approve and send" is what resolves it. A module that sends without a granted `send.person` approval id is a bug the safety reviewer looks for: senders must call `ctx.approval.assertGranted(id, 'send.person', payload)` right before the send, with the exact payload they gave to `request`. The grant is for that one item: a different recipient, subject or body, a missing payload, or a second use is refused (`not_granted`). Grants live in memory: after a restart the item must be approved again.

## Panic

`app/core/panic.js` has one call: `panic.stopAll(reason)`. It aborts the master signal (every job, model call, fetch, browser and child process gets a child of it), runs every `onStop` hook, marks running jobs `stopped`, cancels waiting approvals as `halted`, and sets `halted = true`. While halted, the model door, the job runner and the approval door refuse new work with `halted`. `panic.resume()` clears it. Routes: `POST /api/panic`, `POST /api/panic/resume`, `GET /api/panic`. The Panic button sits at the top right of every screen and works on every page, including during onboarding and inside an agent's computer view.

**Stopped by Panic.** A waiting approval that Panic cancels keeps its row with status `halted` and how `halted` (also when it was waiting inside a job whose signal Panic aborted). Nothing is approved or resumed by itself, and a `halted` row can never be decided or used by `assertGranted`. The owner sees these items (title, agent, action, when) under "Stopped by Panic" in the top-bar Waiting for you list and on Settings › Security, with "Dismiss" and "Dismiss all" and no Approve. Dismissing sets how to `dismissed`; the row and its activity line stay. On Resume one notice says how many waiting items Panic cancelled, if any. Routes (Safety module): `GET /api/m/safety/stopped`, `POST /api/m/safety/stopped/dismiss` with `{ id }` or `{ all: true }`, owner only. `ctx.approval` gains `listStopped()` and `dismissStopped(id | 'all')`, which only take a reminder off the list.

## What a module cannot do (closed 13 Nov)
- **Decide.** `ctx.approval` has `request`, `assertGranted`, `state`, `listPending`, `get(id)` (read-only), `listStopped` and `dismissStopped` (a reminder only). Only the owner's routes decide.
- **Reach core tables with SQL.** `ctx.db` refuses SQL that names `secrets`, `settings`, `approvals`, `activity`, `kv`, `migrations` or `modules`, refuses ATTACH, VACUUM and most PRAGMAs, and allows only SELECT on `agents`, `jobs`, `calls`. Backup and Vault are named in the core as the two modules with the plain door.
- **Fake the shell's safety state.** Modules cannot emit the event types `panic`, `security`, `approval`, `modules`, `settings`, `agents`, `job`, `restart`.
- **Write without the owner.** Every non-GET request to `/api` must carry the session of the desk's own page. `POST /api/panic` is the one exception: anything on this PC may stop the desk; only the owner resumes. `/router/v1` is open to local programs and reaches only the free router.
- **Spend by odd amounts.** A `spend` whose amount is missing, not a number, zero, negative, or in another currency always asks. Paid model calls stop once the day's or month's spend limit is reached.
- **Climb out of an allowed folder.** The folder allow-list compares resolved paths.

Also closed (13 Nov):
- **The card shows exactly what runs.** The payload is stored and shown in full; nothing is cut, and a payload over 256 KB is refused (`too_large`). Fields are hidden only for the actions `login` and `file.read.outside`, and only by exact name (`password`, `token`, `otp` ...). For `send.person`, `shell.run`, `net.post`, `spend`, `file.write` and the rest, the owner sees everything he is approving.
- **SQL scripts.** `ctx.db.exec` runs a script one statement at a time and checks each just before it runs; `prepare`, `run`, `get` and `all` take one statement; modules cannot create triggers or views.
- **Cross-site reads.** A request that a browser marks as coming from another site is refused for `/api`, `/router` and `/modules`, reads included.
- **Event types** are one plain word.

- **Paired browsers (13 Nov).** The desk hands its page, its session and its data only to a browser it knows: the first browser on a fresh desk is remembered by an HttpOnly cookie, and any other must type the code shown in the desk's own window (five wrong tries lock for a minute). Every `/api` and `/modules` request needs that cookie; writes also need the session. Open without it: `POST` and `GET /api/panic`, the pairing page, static shell files, and `/router/v1` (free router only). So a program on this PC, or code run in the Code sandbox, cannot read chats or act as the owner. `createDesk({ pairing })` is off by default for tests; `app/server.js` turns it on (set `APD_PAIRING=off` to run without it).

Known and accepted: a module timer that ignores `ctx.panic` keeps ticking after Panic (everything it tries through the doors is refused while halted); a program already running on the owner's PC with access to his files can read the data folder directly (the Python process sandbox is such a program, which its approval card says).

## Activity log

Every decision (`level`, `auto`, `owner approve`, `owner deny`, `timeout`, `halted`) and every Panic is a row in `activity` with time, agent, action, title, and how. Settings › Backup › Activity log shows it.
