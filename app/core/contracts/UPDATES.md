# Contract 5: signed updates

The desk updates itself only from a release the project signed, only when the owner clicks, and never touches his data. The code is `app/core/update.js` (check, download, verify, stage), `setup/apply-update.mjs` (puts the staged files in place before the desk starts), the routes in `app/core/settings-routes.js`, and the Updates card in Settings › Backup.

## What a release carries

Beside the zips on a GitHub release, two small files:

- `apdesk-update.json`, the manifest:
  `{ "product": "apdesk", "version": "0.1.1", "date": "<ISO time>", "key": "<key id>", "minFrom": "0.1.0", "notes": ["plain line", …], "files": [ { "name": "agent-population-desk.zip", "kind": "windows-zip", "size": <bytes>, "sha256": "<hex>" }, { "name": "apdesk-source.zip", "kind": "source-zip", … } ] }`
- `apdesk-update.json.sig`: an Ed25519 signature over the exact bytes of the manifest, in base64.

`key` names the key that signed it. It is inside the signed bytes, so it only chooses the words of a refusal ("changed after it was signed" for a listed key, "a key this desk does not know" otherwise); trust comes from the signature alone.

## Trusted keys

`app/core/update-keys.json` lists the public keys the desk trusts: `{ "keys": [ { "id", "added", "publicKey" } ] }`, `publicKey` being the Ed25519 key in SPKI DER, base64. Two may be listed while a key is rotated. With none listed the card says "Updates are not set up in this build." and nothing is fetched or offered. The private key never comes near the desk: it lives on the owner's PC, made by `tools/make-update-keys.mjs`.

## Check

- Only when the owner presses "Check for updates", or once a day if he switched on "Check once a day" (off by default, owner-only route). Never while Offline, never while halted by Panic, never for a Git checkout.
- A plain GET with the desk's User-Agent to `https://github.com/agentpopulation/apdesk/releases/latest/download/apdesk-update.json` and `.sig`. Redirects are followed by the updater itself, hop by hop, and only to `github.com`, `objects.githubusercontent.com` or `release-assets.githubusercontent.com` over HTTPS (at most five). No cookie, key or name is sent.
- Refused with a plain line: a signature that does not verify against a listed key; a manifest that is not `apdesk`; a version not higher than the installed one (versions compare as numbers by part); `minFrom` above the installed version; a release dated more than a day before the installed build (`app/version.json` `built`; a source copy has no build date and skips this); no file for this kind of install.
- The card: "You have the newest version (0.1.0).", "Version 0.1.1 is ready, published 21 Nov 2026." (the owner's zone and locale) with its notes, or the reason it could not check.

## Install

Only from the owner's window: `POST /api/update/install` needs the session, and `Updater.install` needs the `SETTINGS_TOKEN` that only `settings-routes.js` holds. A module, a tool call, a chat message or a request flag cannot start it. In order, each step refusing with a plain reason and changing nothing:

1. Check again (as above).
2. Ask through the approval door: `action: 'install'`, title "Update AP Desk from 0.1.0 to 0.1.1", payload `{ kind: 'desk-update', from, version, file, size, sha256, manifest }`. The door asks for this at every level and inside an auto-approve window (APPROVAL-DOOR.md). The updater also requires `how: 'owner'` and the exact payload (`assertGranted`). An approval a module asks for itself installs nothing: installing is done only by the updater.
3. Pick the file: a zip install (no `package.json` at the root, `setup/package.json` there) takes `windows-zip`; a source copy without `.git` takes `source-zip`; a Git checkout is never changed ("This copy is a Git checkout. Update it with git pull.").
4. Download from the release's own tag (`/releases/download/v<version>/<file>`) to `data/update-staged/`, stopping if it grows past the signed size, then check its size and SHA-256. A mismatch deletes it.
5. Unpack into `data/update-staged/next/`: no absolute paths, no drive letters, no `..`, no links, at most 100 000 files and 3 GB; every entry must land inside the folder. The tree must be AP Desk (`app/server.js`) at the signed version (`app/version.json` or `package.json`).
6. Back up the owner's data with the Backup module's own `backupNow` (no keys). Its name is shown on the card.
7. Write `data/update-staged/ready.json` (version, staged folder, top-level names to replace, a hash over every staged file, the manifest's hash, notes) and restart (exit code 75; the start scripts loop on it).

## Apply (before the desk starts)

The start scripts run `node setup/apply-update.mjs` before the server, every time, if the file exists. It always exits 0. With nothing staged it does nothing and prints nothing.

- It copies itself into `data/update-staged/` and runs from there, so the `setup` folder it lives in can be replaced.
- It checks the staged tree against the hash in `ready.json`, then for each top-level program entry (`app`, `modules`, `vendor`, `node_modules` when the release carries one, `start.bat`, `stop.bat`, `README.md` and the rest; `setup` last) moves the old one to `data/update-staged/previous/` and the new one into place. `data`, `backups`, `runtime` and `.git` are never touched. A source copy keeps its own `node_modules` when the release carries none.
- A failure part-way puts every moved entry back and leaves one line the card shows on the next start: "The update to 0.1.1 could not be applied: …. You are still on 0.1.0."
- On Windows a changed `start.bat` is not swapped while `cmd.exe` is running it (it reads the file line by line). It is put beside it as `start.bat.new`, and a small hidden helper swaps it once that window has closed.
- When the new desk starts it removes `previous/` and the card says once "AP Desk was updated to 0.1.1." with the notes. If the new version never started, the next run of the apply step puts the previous files back and says so.

## Routes (owner-only writes, like the security level)

`GET /api/update` (the card's state; once-only lines are shown once), `POST /api/update/check`, `POST /api/update/install`, `POST /api/update/daily` `{ on }`. The plain settings route cannot write `update.*`. The card follows SSE `update` events.

## How to publish a release

On the owner's own PC, never on a shared or build machine:

1. Once: `node tools/make-update-keys.mjs D:\keys\apdesk-release.key` (any path outside the AP Desk folder). Paste the printed entry into the `keys` list of `app/core/update-keys.json` and commit it. Keep the key file offline, with a second copy on a USB stick.
2. Bump the version in `package.json` (for example 0.1.1), and commit.
3. Build the zip: `npm run zip` (writes `dist/agent-population-desk.zip`). Optional source zip: `git archive --format=zip --prefix=apdesk/ -o dist/apdesk-source.zip HEAD`.
4. Sign: `node tools/sign-release.mjs --version 0.1.1 --key D:\keys\apdesk-release.key --note "One plain line" --note "Another"`. It writes `dist/apdesk-update.json` and `dist/apdesk-update.json.sig`, checks them against `app/core/update-keys.json`, and prints the files and the tag.
5. On GitHub, create a release with the tag `v0.1.1` and attach the four files: `agent-population-desk.zip`, `apdesk-source.zip` (if made), `apdesk-update.json`, `apdesk-update.json.sig`. Publish it.
6. On a desk with the previous version: Settings › Backup › Updates › Check for updates. It should say "Version 0.1.1 is ready".

A desk trusts a key only once it runs a version that lists that key: the first version with a key is installed by hand (unzip over the folder); later ones update themselves.
