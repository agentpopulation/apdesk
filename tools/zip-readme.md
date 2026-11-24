# AP Desk

AP Desk is short for Agent Population Desk. Website: https://agentpopulation.com. On X: @agentpopulation. Source code: https://github.com/agentpopulation/apdesk

A local desk of agents for one owner. It runs on your own PC, answers only on `http://127.0.0.1:3445` (or the next free port up to 3465 when another program holds 3445), and keeps everything you own in one `data` folder.

## Install
1. Unzip `agent-population-desk.zip` anywhere. You get an `apdesk` folder.
2. Double-click `install.bat` in it. The installer opens in your browser. It asks where to put AP Desk (there is a Browse button), copies it there, and adds **AP Desk** to your Start menu and, if you like, your Desktop and Settings › Apps. If no browser can be opened, or you run `install.bat /console`, it asks the same questions in the window (press Enter for `%LOCALAPPDATA%\Programs\AP Desk`).
3. Start it from the Start menu: **AP Desk**. It runs in the background; closing a window does not stop it. **Stop AP Desk** stops it, **AP Desk log** shows what it is doing.

It is an install for you only: no administrator rights are needed and nothing is changed for other users. Windows may show its usual notice for a downloaded file; you decide whether to continue.

Node.js is not in the zip. The first run downloads the official Node.js 22 zip for your PC (x64 or ARM64, about 30 MB) from nodejs.org into the `runtime` folder, checks it against its published checksum, and uses it only for AP Desk. The packages the desk needs are already inside the zip.

Without installing: double-click `start.bat` in the unzipped folder. The desk runs in that window until you close it.

## What is in the folder

| | |
|---|---|
| `install.bat` | Installs AP Desk for you: folder, Start menu, Desktop, Settings › Apps. |
| `start.bat` | Starts the desk and opens it. |
| `stop.bat` | Stops it cleanly. |
| `uninstall.bat` | Removes AP Desk. Asks before deleting your data. |
| `README.md` | This page. |
| `app` | The shell and the four doors: models, approvals, storage, modules. |
| `modules` | The 38 modules, one folder each. 20 are on from the first run. |
| `vendor` | Open-source code copied in, with its licences. |
| `node_modules` | Installed packages. |
| `setup` | The installer, `setup.bat` (first run), `reinstall.bat` (repair), `autostart.bat on` or `off` (start when you sign in), the icon and the start page. |
| `runtime` | Made on first run: AP Desk's own copy of Node.js. |
| `data` | Your database, your workspace files, the agents' browser profiles. |
| `backups` | Backup zips. They sit outside `data` so you can delete `data` and restore. |

## Models
Every model call goes through one door.
- **Free API by Agent Population Desk.** Built in. It uses free models that need no sign-in. If you run your own router at `http://127.0.0.1:8787/v1`, the desk uses that instead. You can switch the free models off in Models.
- **Ollama** at `http://127.0.0.1:11434` for local and offline work.
- **Your keys**, typed in under Models. Several keys per provider. OpenRouter is used with free models only unless you switch paid models on in Settings, Payments and spend.

Keys found in the environment when the desk starts are used for that run and are not written to disk: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, or `LLM_BASE_URL` with `LLM_API_KEY`.

## Supported platforms
| Platform | State |
|---|---|
| Linux x64, Node 22 and 24 | Developed and tested here |
| Windows 11 x64 | The main target. The one-line install from a GitHub download was run by the project owner on Windows 11 on 20 Nov 2026 and opened the desk |
| Windows 11 on ARM64 | `install.bat` with its console questions was run by the project owner on 22 Nov 2026: it fetched the ARM64 build of Node.js 22, installed the packages and opened the desk. The agent's browser uses the Edge already installed on the PC |
| Windows, not run yet | The visual installer in the browser, the hidden start, the background mode and the update step have not been run on Windows. They are covered by tests on Linux only |
| macOS | Not run. This zip has no start file for it (`start.command` is in the GitHub download, where the README names it). With Node.js 22.13 or newer installed, `node app/server.js` starts the desk |

## Small local models (4B and 8B through Ollama)
Small models can be picked per agent under Models. How the larger jobs behave on them was **not checked** (no Ollama was available during testing). What the test runs on weak free models showed is the best guide:
- **Chat, renaming, schedules, files:** fine. Where a small model does not call the right tool, the desk runs the step itself.
- **Research, Council, Swarm:** they run, but expect fewer confirmed sources and more "not checked" lines. Every kept citation still has to match its page word for word.
- **Find leads and drafts:** slow, and lead quality drops. Check each draft before approving it.
- **Compare table:** expect many "not checked" cells.
For these jobs give the agent a stronger model as its main model and keep the small one as its fallback.

## Offline
Switch Online off under the message box or in Settings. While Offline the desk process itself refuses every outside call: search, research, browsing, mail and every online model. A router or a search engine running on this PC is refused too, because it forwards to the internet. Only Ollama and the model servers you added on your own network are used.

## Safety
- Security levels Open, Careful and Strict. Open on the first run. Changed only in Settings, Security.
- Auto-approve for 15 minutes, 1 hour or today sits beside the level. It never covers sending to a person or spending over your limit.
- Nothing is sent to a person without your click on that item.
- **Your browser only.** The first browser that opens a fresh desk is remembered. Any other browser must type the six-digit code shown in the desk's own window when started with `start.bat`, or in **AP Desk log** when it runs in the background. Other programs on this PC, and code an agent runs, get no page and no data.
- **Panic** is at the top right of every screen. It stops every agent, job and browser at once. Nothing runs until you press Resume.

## Repair, move, remove
- **Repair:** `setup\reinstall.bat` installs the packages again. Your data is not touched.
- **Move:** stop the desk, move the whole AP Desk folder, then run `install.bat` in its new place and choose that same folder: it only remakes the shortcuts.
- **Back up:** Settings, Backup. The zip lands in `backups`.
- **Remove:** Settings › Apps › AP Desk, or **Uninstall AP Desk** in the Start menu. It removes the shortcuts and the program, and asks before deleting your data. Nothing is installed anywhere else.

AP Desk is open source under the Apache License 2.0. Copyright 2026 AgentPopulation. Licences and credits of the open-source parts: `app\docs\ATTRIBUTION.md`.
