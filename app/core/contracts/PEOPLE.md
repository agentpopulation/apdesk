# Contract 5: the house and its spaces

Several people can share one PC, each with their own chats, memory, leads and keys. The desk is split in two:

- **the house**: one per PC and per running desk. It is shared by everyone.
- **a space**: one data folder with its own SQLite file and its own full core. Each person has one or more spaces (Work, Personal).

What one space holds, no other space can see. What the house holds, every space shares.

## What the house holds

| piece | where in the code |
|---|---|
| the loopback HTTP server, its port, the Host and cross-site checks | `app/server.js` |
| browser pairing (the cookie, the six-digit code) and the windows' tokens | `app/server.js` |
| the people of this PC: names and looks, PIN hashes, wrong tries and waits, the keeper | `app/core/people.js`, in `data/desk.sqlite` |
| Panic: one stop stops every space; Resume resumes every space | `app/core/panic.js` (one `Panic`; each space sees it through `panic.scope()`) |
| Online and Offline, and the offline guard on `globalThis.fetch` | `app/core/offline.js`, `settings.online` (see "Kept by the house") |
| downloads and the local model engine (llama-server and its model) | `app/core/downloads.js`, `modules/models/local-engine.js`, made in `downloads-routes.js` |
| signed updates | `app/core/update.js`, made once in `app/server.js` |
| the install itself: `app/`, `modules/`, `vendor/`, `node_modules/`, `setup/` | |

## What a space holds

A space is built from one data folder by `openSpace()` in `app/core/space.js`. It holds one full core:

| piece | what it keeps |
|---|---|
| `Storage` | its own `apd.sqlite`, `workspace/`, `profiles/`, `bin/`, backups folder |
| `Settings` | the space's settings (theme, level, limits, place, router and model choices ...) |
| `Events` | its own event stream: a window of this space hears only this space |
| `Agents`, `ApprovalDoor`, `ModelDoor`, `Jobs`, `ServiceKeys` | roster, approvals and activity, the call log and spend, jobs, keys |
| `Modules` | its own module set: routes, tools, exposed APIs and every module's activation |

Every module is switched on once per space. Its `activate(ctx)` gets the `ctx` of that space, and everything it keeps lives
in that activation (closures, `ctx.db`, `ctx.kv`). A module keeps nothing in module-level variables that would be shared
by two activations in one process.

A few process-wide helpers keep state for each space on their own: the website rules (`modules/network/rules.js`), data
use per host (`onOutboundBytes` in `app/core/offline.js`), the addresses the offline guard lets through, and the Voice
engines a space started. They find the space of the running code through `app/core/space-context.js`: the core runs a
module's `activate` and `deactivate`, its routes, its tools, its event listeners, its Panic hooks and the functions it
exposes (`modules.api(id)`) inside its space, and so do the space's own doors (`core.jobs`, `core.approval`, `core.model`)
whoever calls them. Timers, promises, servers and child processes started there keep it. The main space is never entered:
its code and code outside every space read the same (no space), so a desk with one space behaves, and costs, exactly as
one desk did before. A listener on a process-wide emitter runs in the space of whoever fired it; a module does not keep one.

While Offline, a call is judged by the allow list of the space that made it: the desk itself, the local engine, and the
Ollama address and LAN model nodes. Those two (`ollama.baseUrl`, `network.lanNodes`) are kept by the house, like
`online`: every space reads the keeper's, and only the keeper's desk can change them. Only loopback, private or
link-local addresses and plain local names count as local (offline.js `isLocalAddress`). A closed space may call nothing.

Closing a space alone (`space.close()`) aborts every signal it was handed (`panic.signal`, `panic.child()`), so its
fetches, model calls and waiting approvals stop with it, then runs its own stop hooks and closes its file.

### Kept by the house

A space other than the main one reads these settings from the house and cannot write them:

- `online`: one switch for the whole desk.

## People, PINs and windows

The house keeps the people of this PC in `data/desk.sqlite` (`app/core/people.js`): each person's name, emoji and colour,
the PIN hash and salt, the wrong tries and the wait, who the keeper is, and a version.

- **Person 1** is made from the existing desk at the first start after this change, with no PIN. Person 1 is the
  **keeper of this PC**, and their space is the data folder exactly as it was (the main space).
- **A new person** gets an empty space in `data/people/<id>/work/` when the keeper adds them. Every person's space opens
  when the desk starts, so their jobs, schedules and Bench run while someone else is at the desk.
- **One person and no PIN** ("open"): the desk behaves as before. The page gets its token, a read without a token
  answers from person 1's space, and a change needs the token.
- **Otherwise** a window gets a token only by entering (person + PIN). A request without a token, or with one that is not
  live, gets nothing but who is here, entering, and Panic.

| route | who | what |
|---|---|---|
| `GET /api/people` | any paired browser | names, emoji, colour, keeper, whether a PIN is set, and a count of what waits for each person (never titles); `you` |
| `POST /api/people/enter` `{ id, pin }` | any paired browser | a token for this window, and a notice: wrong tries since the last entry, who reset the PIN and when |
| `POST /api/people/leave` | the window | the token stops working and its event stream ends |
| `POST /api/people/switch` `{ id, pin }` | the window | a token for the other person; the old token stops working |
| `GET /api/people/me` | the window | the person and their theme |
| `POST /api/people/me/pin` `{ current, pin }` | the window | set or change one's own PIN (the old one is asked) |
| `POST /api/people/me/look` `{ name, emoji, colour, theme }` | the window | only these four keys; a body with any other key is refused and nothing changes |
| `POST /api/people` `{ name, emoji, colour, pin }` | the keeper (with a PIN set) | add a person |
| `POST /api/people/:id/remove` `{ pin }` | the keeper, with the keeper's PIN | the person's windows end and their space closes; the folder is not deleted, the answer says where it is |
| `POST /api/people/:id/reset-pin` `{ pin, newPin }` | the keeper, with the keeper's PIN | the person is told who reset it and when, on their next entry |

Every core route and every module route answers from the space of the token's person. Each window's event stream (the
token goes in the address, `/api/events?session=`) carries only that person's events. Panic stops everyone; any person
who has entered may Resume. The router endpoint for other programs is served from the keeper's space. The paired-browser
cookie means only "this browser may show the chooser".

**The PIN.** scrypt (N=2^15, r=8, p=1), a 16-byte salt, compared with `timingSafeEqual`; 4 to 12 digits. After 5 wrong
tries in a row a wait of 30 seconds, doubling up to 15 minutes, kept on disk so a restart does not reset it. The wait
only ever refuses a *wrong* PIN: the right PIN is checked and enters even while a wait runs, and a wrong try sent while
the wait is already running does not push it out further. So one person cannot lock another out — `POST /api/people/enter`
takes no token, so anyone could send wrong PINs for anyone, but the person who knows their PIN is never kept out by it.
Tries for one person are checked one after another. Each wrong try that was checked goes in that person's activity log.
Forgot the keeper's PIN: `node setup/reset-pin.mjs` at the PC, with the desk stopped, clears it and writes that to the
keeper's activity log.

**The PIN encrypts nothing.** It keeps people at this desk apart. Anyone who can open the files on this PC can read every
person's chats and keys, and code that runs on this PC as the same user can too — the Files guard below is a convenience
for the people sharing one login, not a wall against another OS user. For real separation, use a separate Windows account
for each person and disk encryption. The Files module keeps the whole data folder closed in every space except that
person's own workspace, and also keeps the keeper's backups folder (which lives outside the data folder) closed to
everyone but the keeper; the keeper is told this plainly when they add a person.

**The keeper's gates.** Only the keeper may install updates (every `/api/update` change), switch modules on or off,
switch the desk Online or Offline, start the local engine and model downloads (`/api/local-engine`, `/api/downloads`
pause, resume and cancel, the Models module's Ollama download and delete), add or remove people and reset PINs, show the
six-digit code that pairs another browser (`/api/security/pair-code`, which admits new browsers to the whole PC), and
switch paid OpenRouter models on (`/api/settings/paid-models`; the OpenRouter key is read from the PC's environment and
shared by every space, so a non-keeper must not be able to spend it — spend limits stay each person's own). Anyone else
gets 403: "Only the keeper of this PC can do that." Which modules are on is the house's choice for everyone: a switch
holds for every person's space, and a space other than the main one reads it from the house.

## The folder layout

This version: person 1's space is the data folder exactly as before. Nothing moves.

```
data/                      person 1's space (and, for now, what the house keeps: paired browsers, update and online settings, downloads)
  apd.sqlite  workspace/  profiles/  bin/
  desk.sqlite              the people of this PC
  people/<id>/work/        another person's space
  people/<id>/backups/     that person's backups
backups/
```

When people come (later parts):

```
data/
  desk.sqlite              people, PIN hashes and tries, the keeper, paired browsers, update and online settings, downloads, module on/off
  shared/                  the local engine and its models
  people/<id>/work/        a space: apd.sqlite  workspace/  profiles/  bin/
  people/<id>/personal/    another space of the same person
  people/<id>/keys.sqlite  keys shared by that person's spaces
backups/<id>/
```

## In this version

- The desk opens person 1's space, the main one, from the data folder (`APD_DATA` or `<install>/data`), and one space for
  every other person in `data/people/<id>/work/`.
- Routes serve the space of the window's person. Module routes run inside the space that registered them.
- A space that belongs to no one can be opened only by a test (`desk.openTestSpace`, refused outside `node --test`). No
  route, setting or tool reaches it. `test/spaces.test.js` opens two spaces in one process and shows that chats, memory, leads, jobs, ratings,
  website rules, data use, keys, approvals and events stay in their space, and that Panic and Offline hold for both.
- Keys read from the environment (`OPENROUTER_API_KEY` ...) belong to the PC, so every space sees them.

## Modes: Work, Personal and Incognito

A person has a **Work** space (the default, `data/people/<id>/work/`, and the data folder itself for person 1) and may open
a **Personal** space (`data/people/<id>/personal/`, its own backups in `personal-backups/`). Each is a full space with its
own chats, memory, agents, leads and jobs. The switcher offers Work and Personal **after** the PIN is given for that person,
so switching between them needs no new PIN (`POST /api/people/me/space { space }`; it creates Personal on first use). A
person with only Work sees no choice and behaves exactly as today. Each person's spaces open at desk start.

- **Keys** are each space's own in this version. The full move to a shared `data/people/<id>/keys.sqlite` was deferred: it
  would rework `modules/backup/archive.js`, whose per-space backup/restore is a keeper gate (`DELETE FROM secrets`, the
  trusted-restore checks and `13_backup_foreign_restore`), and a half-moved keys store risks either losing keys or leaking
  them. So a person adds their keys in each space they use. A person's keys are still never seen by another person or by
  Incognito. (`storage.js`, `modules.js`, `model-door.js`, `service-keys.js`, `vault/server.js`, `backup/archive.js`.)

**Incognito** (`POST /api/people/incognito`) is a full space on an **in-memory** SQLite with a scratch workspace folder
`data/people/<id>/.incognito-<rand>/` (its own `workspace/`, `profiles/`, `bin/`) and its own browser profile there. Every
write — chat history, memory, the visit log, the call log, Finder's page library, ratings, approvals, Bench — lands in RAM
or the scratch folder only. It reads none of the person's real memory, chats, leads or rules: it starts empty. Bench's away
session (`/api/m/bench/start`), schedules (`/api/m/flows/schedules`, the `schedule_create`/`flow_create` tools) and
downloads (`/api/local-engine/*`, `/api/downloads/*`) are refused in it, in plain words. Outbound still goes through the
address guard and the website rules; approvals still apply; Panic still stops it.

- **Spend is the one carry-over.** The Incognito door reads the person's own limits and counts the person's day and month
  totals, so Incognito cannot get around the limits; `core.approval.spendCarry` holds the real door. On leaving (lock,
  switch or close) it writes **one** row to the real desk holding only the amount — no title content, no payload, no detail.
- **Leaving** drops the in-memory database and deletes the scratch folder. A scratch folder left by a crash is wiped at
  desk start. Deleting the scratch files is **not** a secure wipe on an SSD, and what left the desk (a sent mail, a visit a
  site logged, money spent) is still known outside it — the Incognito screen says so (`GET /api/people/me` `cautions`).
- The proof is `test/incognito.test.js`: every durable file's hash is the same after an Incognito session apart from the one
  amount-only spend row, the canary string is nowhere under `data/`, `backups/` or the OS temp folder, and the scratch
  folder is gone.

## What later parts add

- Moving an existing data folder into `data/people/<id>/work/`, with a journal and a safety copy.
- The person switcher and chooser on screen (the routes are above).
- Keys in a shared `data/people/<id>/keys.sqlite`, once backup/restore can carry it without weakening its keeper gate.
- A whole-PC backup.
