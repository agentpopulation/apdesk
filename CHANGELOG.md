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

### Known weak points
- No run of the 17 acceptance asks has passed every ask. Results vary with the free model that answers.
- In the last full run (14 Nov 2026) two asks failed: the compare-table reply stated values the file marks "not checked", and the lead search returned some companies from the wrong country.
- Free models can be slow or busy: on 15 Nov 2026 one plain chat question got no answer in over four minutes.
- A table inside a chat reply can show as plain text (seen 15 Nov 2026).
- PDF documents made by the Office module leave out Hindi and other Indian-script text: the built-in PDF font has no such letters (seen 15 Nov 2026).
- The "Stopped by Panic" list shows in the top-bar pop-up and in Settings › Security, not yet on Home or Tasks.
- Ask 2 (offline with a local model) has never been checked: no test run so far had Ollama installed.
- Small local models (4B, 8B): not checked.
- Offline does not cover programs the desk starts as separate processes, mail servers, or DNS lookups.
- The process sandbox for code is not isolation.
- A module timer that ignores Panic keeps running after Panic; everything it tries through the desk's doors is refused
  while halted (`tools/safety/05_panic.js`, 14 Nov 2026).
