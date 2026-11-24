# Contract 6: approve from your phone

Waiting approvals show on a phone on the same Wi-Fi; Yes or No there decides them. Nothing leaves the home network.
The code is `app/core/phone/` (the server part, the page and its script), wired in `app/server.js`.

## Safe by construction

- **Off by default.** The setting `phone.on` is written only by `POST /api/phone/switch { on }`, which is Admin-only
  (KEEPER_ONLY in `app/server.js`) and needs the session of the desk's own page. The plain settings route refuses `phone.*`.
- **A second listener, not the desk.** When on, the house opens one more HTTP server bound to the PC's home address (the
  first private IPv4: 10/8, 172.16/12, 192.168/16) on the desk's port + 2 (`APD_PHONE_HOST` and `APD_PHONE_PORT` set
  them; tests use `127.0.0.2`). It is a separate handler that knows only: `GET /`, `GET /phone.js`, `GET /phone.css`,
  `POST /link`, `GET /list`, `GET /show/:id`, `POST /decide/:id`, `POST /unlink`. Every other path answers 401 without a
  phone's token and 404 with one. The desk's own listener stays on 127.0.0.1 with its Host check unchanged. No home
  address: the listener does not open and Settings says why.
- **Its own checks.** The Host header must be the listener's own address (DNS rebinding); the caller must be on a local
  address; a POST must come from the page itself (Origin and Sec-Fetch-Site); bodies are capped at 4 KB; the page is served
  with `default-src 'none'` and no inline script.
- **Linking.** A person who has entered (never from Incognito) presses Make a code in Settings › Approve from your phone:
  `POST /api/phone/code`, a page fetch from a paired browser only. Six digits, one per person at a time, five minutes,
  one use. Five wrong tries in a row lock linking for five minutes and drop every live code. The phone gets a 32-byte token
  kept in its own browser storage; the desk keeps only its SHA-256 (house kv `core.phone`, `devices`), with a name, the
  person, when it was linked and when it was last used.
- **Removal.** Settings lists the person's phones (the Admin sees and removes all): `POST /api/phone/devices/:id/remove`.
  A removed phone's token is refused at once. Taking a person off the desk removes their phones. The phone can unlink itself.

## What the phone shows and decides

- Only the linked person's waiting approvals, from their Work and Personal spaces. Never an Incognito space.
- Each item: the title, who asks, the kind of action, the desk card's detail line, the amount in the owner's currency, and
  when it was asked in the owner's zone. What the approval covers (the payload, a message's text) is sent only when the
  owner taps Show, and then with every field that names a key, password, token or PIN hidden (`redact`), whatever the action.
  A download's own bookkeeping and raw address stay off, as on the desk's card.
- Yes and No call `approval.decide(id, decision, 'owner', <phone name>)`: exactly that one approval, as that person, once.
  A decision already made (at the desk or on another phone) is answered 409 with what it was. The activity log line says
  "Decided on the phone "<name>"".
- `install` and `module.toggle` show "Decide this at the desk." unless the Admin switches on `phone.adminDecides`
  (`POST /api/phone/admin-decides`, Admin-only); then only the Admin's own phone may decide them.
- Panic: nothing is listed or decided; the page says so. The screen lock: nothing is listed or decided.
- Offline: the phone page makes no outside call and loads nothing from outside, so it works while the desk is Offline.
- Plain http: the page says on top that someone on the same Wi-Fi could read what it shows, and that it never shows secrets.

Probe: `tools/safety/23_phone.js`. Tests: `test/phone.test.js`.
