# AP Desk

AP Desk is short for Agent Population Desk. Website: https://agentpopulation.com. On X: @agentpopulation. Source code: https://github.com/agentpopulation/apdesk

A local desk of agents for one owner. It runs on your own PC, answers only on `http://127.0.0.1:3960`, and keeps everything you own in one `data` folder.

## Start
1. Unzip `agent-population-desk.zip` into a folder of your choice, for example `C:\Apps`. You get an `apdesk` folder inside it.
2. Double-click `start.bat`. The desk opens in its own full window.
3. To stop it, double-click `stop.bat`.

The first start needs Node.js 22.13 or newer. If it is missing, `start.bat` runs `setup\setup.bat`, which installs it with winget. The packages the desk needs are already inside the zip, so no download is needed after that.

## What is in the folder

| | |
|---|---|
| `start.bat` | Starts the desk and opens it. |
| `stop.bat` | Stops it cleanly. |
| `README.md` | This page. |
| `app` | The shell and the four doors: models, approvals, storage, modules. |
| `modules` | The 30 modules, one folder each. 16 are on from the first run. |
| `vendor` | Open-source code copied in, with its licences. |
| `node_modules` | Installed packages. |
| `setup` | `setup.bat` (first install), `reinstall.bat` (repair), the package list. |
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
| Windows 11 x64 | The main target. An earlier build of 0.1.0 was run and tested on Windows 11 on 14 Nov 2026. This exact build has not been re-run there yet |
| Windows on ARM64 (Snapdragon X) | Should work, **untested**. The desk is plain JavaScript on Node 22.13 or newer with `node:sqlite`; the zip holds no native add-ons. The agent's browser uses the Edge already installed on the PC |
| macOS | Untested. There is no start script for it; `node app/server.js` is the way in |

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
- **Your browser only.** The first browser that opens a fresh desk is remembered. Any other browser must type the six-digit code shown in the desk's own window (the one `start.bat` opened). Other programs on this PC, and code an agent runs, get no page and no data.
- **Panic** is at the top right of every screen. It stops every agent, job and browser at once. Nothing runs until you press Resume.

## Repair, move, remove
- **Repair:** `setup\reinstall.bat` installs the packages again. Your data is not touched.
- **Move:** stop the desk and move the whole `apdesk` folder.
- **Back up:** Settings, Backup. The zip lands in `backups`.
- **Remove:** stop the desk and delete the folder. Nothing is installed anywhere else, apart from Node.js.

AP Desk is open source under the Apache License 2.0. Copyright 2026 AgentPopulation. Licences and credits of the open-source parts: `app\docs\ATTRIBUTION.md`.
