# Changelog

Test results named in this file come from the project's own checks. Dates are in IST.

## 0.1.0 (15 Nov 2026) — AP Desk as its own project

AP Desk (Agent Population Desk) now lives in its own repository. Work on it began on 13 Nov 2026. Parts of this code come
from the author's earlier private work; open-source packages are listed in `ATTRIBUTION.md`. Everything below was
built and tested on Linux. An earlier build was run and tested on Windows 11 on 14 Nov 2026; this exact code has not
been re-run there.

### Published as open source (15 Nov 2026)
- Licence: Apache License 2.0. `LICENSE` and `NOTICE` added; copyright AgentPopulation.
- New README with pictures; the zip keeps its own plain README (`tools/zip-readme.md`).
- Build notes that only made sense on the first build computer were removed; `ATTRIBUTION.md` now lists third-party work only.

### Changes on 14 Nov 2026
- Name: the desk is called AP Desk by default; Settings, General has "Name of this desk" and "Your business".
- Offline is held inside the desk process: while Offline only Ollama, your own LAN model servers and the desk itself are called. A router or search engine on the same PC is refused, because it forwards online. The agent's browser blocks outside requests the same way.
- Approvals given once at Careful end with the chat turn or the job, and never last over 15 minutes.
- A job that needs your approval shows "waiting" with the reason. A finished job shows a notice, a count on its menu place and, in a background window, a desktop notification.
- A reply can no longer write or change a file. A reply that claims a job, a draft, a schedule or a saved file that no step made has the claim removed.
- A stopped, failed or offline ask is never picked up again by a later turn; scheduled runs and background tasks act only on their own prompt, with a short note of the chat they came from.
- One ask starts one background task. "In 20 minutes, remind me to …" makes a one-time schedule; a question that merely mentions a time does not.
- Compare tables: a cell is confirmed only from a page that was read, next to the product's full name and the column's own word or unit; the file is always made, with "not checked" where needed, and the reply's summary of what was confirmed is written from the check itself.
- Research: claims are written from passages found word for word on the pages read; reports about a named organisation read its own site first and leave out look-alikes; figures that cannot be right together are marked "not checked"; a search that fails names each provider and its error and stops within about 25 seconds.
- Leads: one row per company, namesake and wrong-country sites refused, Wikipedia-only leads left out, the asked count refilled after merges. "Top N" means the first N rows of the table last shown in that chat.
- Drafts: subject and body are separate; drafts in Hindi and other Indian languages are accepted and checked by script; LinkedIn, WhatsApp and plain text drafts are copy-only; a send approval is asked only when you press "Approve and send"; a draft with no address cannot be sent.
- Briefs state only what the desk's records hold, with each finished job's own summary quoted as it is.
- Council: seats and the chair are spread across different models; the Verdict says how many seats agree, worked out from what they recommend; figures not taken from a page are marked "not checked".
- The nightly Dream runs only from its own 3:17 AM timer or your "Run Dream now" button.
- Shell: a pop-up closes when the page changes; the top bar holds with many modules on; Flows shows no internal ids.

### Changes on 15 Nov 2026
Rules that read the owner's words with patterns and then forced or rewrote the model's work were doing harm. These were narrowed or removed:
- Sending: "Approve and send" now fetches the draft as stored, shows the exact address, subject and full body, and the server refuses if the draft changed in between. An older card in chat can no longer show one address while another is approved.
- A second task is skipped as a repeat only when its wording is identical. "Research X in Pune" and "in Bangalore" both run.
- A language is taken only from a clear instruction ("in Hindi", "हिंदी में"); "leads in Tamil Nadu" is a place. The owner's count is used when stated ("3 emails", "these three"); otherwise the model's own count stands.
- The desk no longer deletes ordinary sentences or table rows from a reply, and no longer adds or guesses units in table cells.
- A sentence saying a named file was saved, when no step in that turn wrote it, is removed whether or not an older file has that name; text the desk builds from its own records is not checked this way.
- Briefs are written entirely by code from the desk's records, with true counts. No model is involved.
- Council no longer rewrites sums in answers.
- Research never cites a reference-list entry, and compares two values only when both carry the same unit.
- Leads: a firm named "X Enterprises" is not treated as enterprise-only; company names in every script are kept apart; a company a page plainly places in another country is left out.

### Later on 15 Nov 2026
- One-file starters: `start.sh` for Linux and `start.command` for Mac, next to `start.bat`. The first start installs the packages and opens the desk in the browser. Run on Linux; not yet run on a Mac.
- Lead search: when the ask names a country, a lead is kept only if a page that was read places the company there. Its findings say what placed it, and a shortfall reads "N of M found that could be placed in India".
- Lead search: a repeat request in the same chat while a search is running returns that search instead of starting a second one.
- Council: each seat now ends its answer with a one-line recommendation, and the Verdict counts agreement from those lines. A seat that gives none is said plainly ("2 of 3 seats recommend X; one seat gave no clear recommendation") instead of the agreement line being dropped.
- Panic no longer makes waiting approvals vanish. They are listed under "Stopped by Panic" (in Waiting for you and Settings › Security) with Dismiss and Dismiss all, and one notice after Resume says how many were cancelled. Nothing is approved or resumed by itself.
- PDF text in previews, file reading and Knowledge now comes from the shipped pdf.js reader; PDFs made by the desk's own Office module no longer read as garbled text.
- Models › Per agent: the main-model select shows "Desk default"; hover it to see the full model chain.
- With "reduce motion" set in the system, the desk stops its decorative animations.
- Windows zip trimmed from 39.9 MB to 18.4 MB: packages ship without type declarations, source maps, docs, tests, examples or browser-only builds. Every module and heavy package was checked from the unzipped copy.
- Sales tests and fixtures use invented companies and domains only.
- A chat reply no longer sits silent: the chat shows what the desk is waiting for, and a model that gives no reply or new text within 150 seconds ends the turn with a plain message and Try again.
- Tables and lists in replies keep their line breaks. A table in the answer no longer makes a file; Excel, Word and PDF files are made only when the ask is for a file. Home previews show plain words.
- A checked table file's reply is written only from the check, so no unconfirmed value is stated. Tool calls written as text run or are dropped, never shown. A started job's acknowledgement no longer says "No file was saved."
- A model reply that stalls mid-stream is dropped after 45 seconds and the next model is tried; one model call stops trying new models after 170 seconds.
- Deep research, the Council, swarms, lead search and browser tasks start only when the ask names them (or in Scout's, Closer's or Operator's own chat); otherwise the reply may say the option exists.
- A plain question is answered in the chat: background tasks, hand-offs to other agents, schedules, chains of agents, web travel plans, site builds and outreach drafts start only when the ask is for them.
- A file is written only when the ask is for a file, names a workspace file or folder, asks to save, edit, update or note something down, or the chat has an attached file.
- Tables in chat replies keep whole words in their headers, keep short cells on one line, use the full width of the conversation, and scroll sideways when wider. A streaming reply no longer flickers.
- Lead search: the closing line counts own sites, mail addresses and contacts over the leads shown, and never prints a count larger than the number of leads.
- Lead search: when the ask names a kind of product, a lead is kept only when a page that was read says what the company itself sells; staffing, consulting and IT-services firms, and names that only appear on a list page, are left out with a stated reason.
- The nightly memory tidy no longer looks like your work: no notice, menu count or Home line, and it stays out of the morning brief. It is listed under Housekeeping in Tasks, and you are told if it fails.
- Notices appear in the top bar, so they no longer cover page titles or the chat header. A long Council Verdict line wraps instead of being cut off.
- Home and Tasks also show what Panic cancelled, under Waiting for you.
- Acceptance runner: file names with several dots are read whole, judge answers are read from a strict last-line YES or NO (unclear means "not checked", never a pass), Council answers that end on their Recommendation line count as complete, Panic is tested on a running research job, and `npm run acceptance` points at the real runner.
- Lead search fills the asked count: checked leads first, then leads marked "Country: not checked" or "What it sells: not checked" in a separate labelled group. Leads a page places elsewhere or names as another kind of business are still left out. Drafts for not-checked leads do not state their country or product.
- A background task or scheduled run that did not do what it was asked shows "Did not finish" with the reason in plain words, in the chat, on the Tasks page and in the morning brief. A task that started research waits for the research before it counts as finished.
- Research asks go to Scout, and the research report is the brief. While a write waits for your approval, the reply says so instead of claiming the file is written.
- Previews and titles end at a whole word with "…". The rail shows an agent's role when its last message is not a useful preview. On narrow screens the chat panel starts closed.
- Notices sit in free space in the top bar, or as one slim line under it that the page makes room for; they are always opaque and never cover the menu or the page.
- A research report calls two figures a conflict only when they are for the same thing in the same year.
- Acceptance runner: the Panic check counts only jobs created after the desk registered Panic, and an unclear judge answer is reported as "judge unclear", not as unsupported.
- Acceptance runner: the lead-search ask reads both lead tables (checked, then "Not checked"), counts their rows together, and fails on unlabelled not-checked rows, a closing line that disagrees with the tables, or a list that is mostly unchecked. An honest shortfall still counts as a fail.

### 20 Nov 2026
- `start.bat` from a GitHub download did nothing on Windows. Two causes, both repaired: `setup\setup.bat` had lost the lines that close its install block and the label that block calls, and the `.bat` files were stored with Unix line endings. The zip with the packages inside was not affected, because it never runs the install step.
- The Windows scripts are now stored with Windows line endings, and a test checks every `.bat` file for line endings, closed blocks and missing labels.
- The README's Quick start now opens with one copy-and-paste line per system that downloads AP Desk and starts it.
- Run on a Windows 11 PC by the project owner on 20 Nov 2026 with the one-line install: it downloaded, installed the packages, started all 16 default modules and opened the desk.
- First start now asks what you sell, lets you pick your starting team, and says which models answer and how to make them faster.
- When an ask means "my product" and the desk does not know it yet, it asks once, saves your answer, and carries on with the same ask.
- Settings › General shows "Saved" beside each field. A fresh desk takes its time zone, country and currency from your computer; a desk that was already set up keeps what it had.
- The built-in free models are now called "Free API by Agent Population Desk" ("Free API" on replies), and no title on the Models page is cut.
- A failed Test says why, local models get a fair first-call wait, and the Default model box lists every model: OpenRouter's whole list even before a key, each marked Free or Paid.
- Paid OpenRouter models are switched beside the keys or in Payments, by the owner only, from the desk's own window. A new safety probe checks that nothing else can switch them on.
- Free hosts that say no are skipped for a while instead of being retried, and when all of them are busy the desk says so at once with when to try again.
- The routing model is named "APDesk Edge 63M" in the README.
- After a few chats, the desk asks once whether you want short or detailed answers, with a sample of each; your agents then answer that way, and you can change it in Settings › General.
- Updates: the desk can check GitHub for a new version and install it on your click, only if the release is signed with the project's key. Until a key is added to the build it says "Updates are not set up in this build."
- A backup of your data is made before every update; your data, backups and keys are never changed, and a failed update puts the old version back. A desk update always asks you, even inside an auto-approve window.
- New tools for the maintainer: make a signing key and sign a release (`tools/make-update-keys.mjs`, `tools/sign-release.mjs`).
- Windows: new `install.bat` installs AP Desk for your user only, with a folder of your choice, Start menu, Desktop and Settings › Apps entries, and an optional start when you sign in. It needs no administrator rights; `uninstall.bat` asks before deleting your data.
- Windows: AP Desk keeps its own checked copy of Node.js 22.23.5 (x64 or ARM64) in its folder instead of installing Node.js for the whole PC, and runs in the background with a log under `data\desk.log`.
- The default address is now `http://127.0.0.1:3445`. When another program holds that port, the desk takes the next free port up to 3465 and remembers it. A start page shows while the desk loads.
- Bench mode (off by default): while you are away from the desk's window, it looks back at its own work and looks up your market in stages (1, 12, 36, 108 hours), then leaves a note.
- Everything Bench finds is a proposal with its source pages; nothing is sent, saved or changed until you press Keep, Dismiss or Turn into a task. It stops the moment you use the desk, stops on Panic, waits on battery and offline, and uses local then free models within fixed budgets.
- A lead search now says plainly what it searched for and for whom.
- Models: "Get a local model" fetches llama.cpp and a model that fits this PC in the background, checks both, and runs them on this PC only. It works Offline, and Remove frees the space.
- A downloads service with pause, resume and cancel. Every download asks first, Panic pauses it, and it goes on after a restart.
- Network now has its own page in the menu: connection and public address, speed and latency over time, websites to watch, where the agents went, "Is it me or them?", AI provider speed, devices, your domain, what listens here, domain lookups and desk data use.
- Website rules: sites agents may never open, and sites they open only after asking you, enforced in search reads, research and the agent's browser while the Network module is on.
- In the Network module nothing calls an outside service by itself; schedules are off by default, wait while Offline and stop with Panic.
- A free host that has not started answering within 25 seconds is skipped (it was 60), so more of them get a try inside one chat turn.
- A new desk opens the chat with two buttons, "Say hello" and a highlighted "Select model / Add API"; the role's suggestions appear once the first reply has finished, and a small "Select model / Add API" link stays beside the model name.
- The side panel never sends an empty request: "Turn into a task" offers to run the chat's last ask again in the background, and a message that is only a prefix is refused.
- Work the chat finished in the last hour for the same ask is not restarted by itself; lead tasks go to the agent whose role is leads; times and money follow your settings everywhere.
- A built-in agent left out at first start or retired later shows under "Not on your team" on the Agents page, and one click hires it back as it was, with its chats and rooms.
- Briefs, schedules, calendar dates, lead values and spend amounts follow your own zone, locale and currency; nothing falls back to India any more.

### 21 Nov 2026
- Bench mode now asks how it may spend before it runs: Local only, Free, or Paid with a per-session and per-day cap you set; it waits for your choice, and when a cap is reached it winds back to free and asks you again.
- Bench holds to session limits whatever the choice: tasks, sources fetched, steps and minutes of work, winding down at 80 percent of any one and stopping with a checkpoint at 100 percent; the Bench page header shows your choice, today's spend and how close the limits are.
- You can rate any answer and any Bench finding: good or poor on the answer, strong or weak on the research, with reason chips and a note; ratings are only collected for now.
- A "While you were away" page shows, on your return, what finished, what needs you, time worked and today's spend, with result cards you can open, rate, or follow up, and an honest list of what the desk did not get to and the suggested next step.
- Each Bench result carries a "How I got this" timeline: the desk's own record of what ran, the models and pages and how long each took, kept factual rather than a model's stated reason.
- The top bar shows small icons instead of words: a sun or moon for the theme, a network light (green up, red no internet, grey off by choice), and a download count with a live list.
- Switching a module on or off in Settings keeps your place on the page instead of jumping to the top.
- First start can download a local model in the background, only after you press Save and allow each download.
- When the desk runs hidden, the six-digit code for pairing another browser is shown under "Show code" in Settings, Security, not written to the log; you can also install the desk as an app.
- The agent's browser now checks every request at every hop (redirects, frames, images, scripts, fetch, WebSockets, WebRTC) through a small guard on this PC, which looks names up itself, so nothing a page does can reach this PC or your home network.
- A redirect into an "ask first" site now waits for your yes just like a direct open, and "never" sites stay blocked on every hop.
- The Network page now shows a status strip along the top: agents online, mid-task, idle and in error, messages a minute, the task queue, open issues, new devices and a heartbeat light, with a dash where the desk has no number yet.
- A new API connection health section times each known provider endpoint, with its last latency, last check and 24-hour error rate; the check runs only on your button or a schedule you turn on.
- Your public and local IP addresses are now kept with a change history, and your public address is recorded each time you look it up.
- For your own domains the desk can resolve A, AAAA, MX, NS and TXT records on a schedule you choose and keep a log of what changed.
- The network operator (ASN) behind your public address and your domains is tracked and flagged when it changes.
- A single network issues list gathers certificate expiry, DNS failures, high latency and packet loss, each with a severity, and any of them can be muted.
- The Connection view gains an active-connection detail with the adapter, signal, gateway, subnet, DNS servers and MTU, and names the fields this PC does not report.
- Updates are checked once a day while the desk is Online (switch it off in Settings, Backup, Updates). Nothing is checked while Offline, after Panic, or in a build that has no update key. The last check is kept and shown after a restart.
- Updates now have two channels: Stable (the default) and Preview, which also gets test versions. A release names its channel inside its signature, so a test version cannot be passed off as stable. The desk never offers a version lower than or equal to the one you have.
- The Updates card shows what changed in a new version before you press Update now, as plain text.
- A new switch, Download updates in the background (off by default): a new version is downloaded and checked ahead of time and shows in Downloads, where you can pause it; Panic pauses it. Installing still asks you every time.
- Release signing takes the notes from a text file (--notes) and the channel (--channel stable or preview).
- Finder, a new search module (off until you switch it on): it asks several search providers at once with a few wordings of your question and answers with the best passages, each quoted word for word with its address and the time it was read.
- Every page Finder reads is kept in a private library on this PC that you can search while Offline, with a size limit, Clear, and a list of sites never to keep. Your website rules apply to kept pages too.
- Agents get two new tools, find and library_search; web_search and web_read are unchanged. A fixed set of 45 questions with stand-in pages measures search changes without the internet (old path 28 of 45, Finder 44 of 45, on stand-ins only, 21 Nov 2026).
- APIs, a new module (off until you switch it on): say what you need data for, pick a topic, and get that topic's public endpoint pack from AgentPopulation only when you press Get. The pack is checked before use, searched on this PC, works Offline, and Remove frees the space.
- Try it makes one read-only call with no key or cookies, with size and time limits, and shows a short sample marked as outside data. Endpoints you switch on under "Agents may use" become tools for your agents, and your website rules still ask.
- Every row and result carries the AgentPopulation credit line (CC BY 4.0) and says the terms of each API were not reviewed. A field a pack left empty says "not checked". No real pack or API was called in the checks so far.
- Sales now has a CRM: Contacts, Companies and Deals tabs beside Leads. Every row keeps where it came from and when, and fields no record gave are marked "not checked". The desk never sends to a contact by itself.
- A lead goes into the CRM with one press (Add to CRM). Duplicates merge by site, mail address or name, and the merge keeps both sources.
- Deals have a board and a list, stages you can rename, a value in your currency and a next-step date in your time zone.
- You can mark companies as customers, import your customers from a CSV with a preview of every row before anything is saved, and export contacts, companies and deals as CSV.
- Tables, a new module (off until you switch it on): give a public page address, pick the list on it and say what each column is. The desk keeps that one list, and its companies and contacts in the CRM, up to date with the page address and the date read on every row.
- A refresh reads only the saved address and says plainly when the table changed, moved or is gone, keeping the last good copy. Lists split over pages are followed on the same site up to a page limit you can see.
- Every page read honours robots.txt and your website rules, on redirects too; no sign-in, no form, no bot check is attempted; nothing is ever sent. "Remove everything from this source" takes back its rows and what it filled in. Checked on stand-in pages only, not yet on a real event site.
- Bench keeps a heartbeat every 30 seconds and shows on the return page when the desk was not running, in your time zone. After any restart a session picks up at the activity that was cut off.
- Keep awake (a Bench setting, off by default) holds the PC awake with the system's own tool only while Bench has work that can run now, and lets go on Panic and on exit. It was tested with a stand-in only; it has not been run for real on Windows, macOS or Linux.
- Each Bench session shows its to-do list with an estimate of the time left, and results can come with a Draft (a one-pager or a list of next actions) that you can edit, make again, accept, discard or hand to Mail drafts yourself.
- Today's find (one question a day picked from your own history in the desk), a Rulebook proposed from your workspace files with file and line, and a weekly "What I learned" note from your ratings. All are suggestions; nothing changes by itself.
- Bench marks leads that are already in your Sales customers list as "already a customer", matched by name or site.
- Settings has a new Menu section: rename, reorder, hide or show menu places, pick the first page, or reset to the default menu. Your names show in the menu, page titles and notices; customising never changes permissions.
- A Tracker icon in the top bar counts running jobs. Its pop-up and the Tracker page show what each agent is doing, the to-do list with time left where a job reports one, downloads, Stop and Panic, updated live.
- A small dot in the top bar says a checked update can be installed and opens Settings, Backup, Updates; it installs nothing. Desktop notices now also say when a job needs you.

### Known weak points
- Website rules apply only while the Network module is on, and an open auto-approve window lets an "ask first" site through.
- Phone notices for watched websites use ntfy only, not Telegram.
- The local model engine was run for real on Linux only (a 1 GB model answered through the desk on 21 Nov 2026). Windows and macOS builds are chosen by rule and have not been run.
- The Windows installer, the background mode, the start page and the update step have been tested on Linux and by static checks only; none has run on Windows yet.
- Bench mode's later stages (customers, funding, market report) have not been run with a real model, and its early findings are of mixed quality.
- With no key and no local model, the free hosts are often busy: on 20 Nov 2026 a first "Hello" got no answer within 150 seconds in one test run. A free key or a local model in Models avoids this.
- A real local Ollama model has still not been run through the full set of checks.
- No run of the 17 acceptance asks has passed every ask. Results vary with the free model that answers.
- In the run on this code (15 Nov 2026) 13 asks passed, 3 failed and 1 was not checked. The three: the research report quoted one sentence about a different technology as on-topic; the compare table got no model answer within 150 seconds on its first run, and on its second run confirmed 5 of 12 cells; the lead search listed 20 leads (13 checked, 7 labelled "not checked") and the runner counted only one of its two tables.
- An ask to research something "in the background" can start two jobs for the same work (seen 15 Nov 2026).
- A research report's quotes are checked word for word against their pages, but not for being about the topic.
- PDF documents made by the Office module leave out Hindi and other Indian-script text: the built-in PDF font has no such letters (seen 15 Nov 2026).
- A lead search lists some leads as "not checked" when no page it read said where the company is or what it sells; some of those will be real fits.
- Code you approve in the Code module runs without isolation unless Docker is installed: it can read files on this PC, including the desk's own database.
- Ask 2 (offline with a local model) has never been checked: no test run so far had Ollama installed.
- Small local models (4B, 8B): not checked.
- Offline does not cover programs the desk starts as separate processes, mail servers, or DNS lookups.
- The process sandbox for code is not isolation.
- A module timer that ignores Panic keeps running after Panic; everything it tries through the desk's doors is refused
  while halted (`tools/safety/05_panic.js`, 14 Nov 2026).
