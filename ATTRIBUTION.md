# Attribution

AP Desk (Agent Population Desk) uses, or can optionally run beside it, the open-source packages, repositories, public
APIs and data sources below. One line each: name (licence) URL: what it does here (file). Licences are as stated by each
project.

## Packages in `package.json`

- @modelcontextprotocol/sdk (MIT) https://github.com/modelcontextprotocol/typescript-sdk: the MCP client, stdio and streamable HTTP (`modules/connect/server.js`).
- @mozilla/readability (Apache-2.0) https://github.com/mozilla/readability: main text of web pages (`modules/search/reader.js`).
- adm-zip (MIT) https://github.com/cthackers/adm-zip: reads docx/xlsx/pptx for Knowledge and previews (`modules/files/convert.js`); writes and reads the backup zips (`modules/backup/archive.js`).
- croner (MIT) https://github.com/Hexagon/croner: every stored schedule is a croner job in the owner's time zone; also validates timetables and finds missed runs (`modules/flows/server.js`, `modules/flows/when.js`).
- docx (MIT) https://github.com/dolanmiu/docx: Word documents from Markdown (`modules/office/make.js`), and report Word files when Office is off (`modules/research/export.js`).
- DOMPurify (Apache-2.0 or MPL-2.0) https://github.com/cure53/DOMPurify: cleans the Markdown HTML before it reaches the page; browser build `vendor/dompurify/purify.es.mjs` v3.4.17 (`modules/chat/ui.js`).
- exceljs (MIT) https://github.com/exceljs/exceljs: xlsx tables (`modules/office/make.js`).
- ical.js (MPL-2.0) https://github.com/kewisch/ical.js: independent parse of Calendar's exported .ics in `modules/sales/real-check.mjs`; not used by the running app.
- imapflow (MIT) https://github.com/postalsys/imapflow: read-only IMAP fetch for the Mail inbox (`modules/mail/server.js`).
- linkedom (ISC) https://github.com/WebReflection/linkedom: the DOM Readability runs on (`modules/search/reader.js`).
- mailparser (MIT) https://github.com/nodemailer/mailparser: plain text of mail from allowed senders (`modules/mail/server.js`).
- marked (MIT) https://github.com/markedjs/marked: Markdown lexer for Word and PDF output (`modules/office/make.js`); Markdown in chat replies, browser build `vendor/marked/marked.esm.js` v18.2.0 (`modules/chat/ui.js`).
- nodemailer (MIT-0) https://github.com/nodemailer/nodemailer: SMTP sending in Mail (`modules/mail/server.js`).
- pdfkit (MIT) https://github.com/foliojs/pdfkit: PDF documents from Markdown (`modules/office/make.js`), and report PDF files when Office is off (`modules/research/export.js`).
- Playwright / playwright-core (Apache-2.0) https://github.com/microsoft/playwright: drives each agent's own browser (`modules/browser/computer.js`).
- smtp-server (MIT-0) https://github.com/nodemailer/smtp-server: the loopback mail server in Mail's checks (`modules/sales/real-check.mjs`, `modules/mail/mail.test.js`); not used by the running app.
- systeminformation (MIT) https://github.com/sebhildebrandt/systeminformation: CPU, RAM and graphics memory for the Models hardware scan (`modules/models/hardware.js`).
- turndown (MIT) https://github.com/mixmark-io/turndown: page HTML to Markdown (`modules/search/reader.js`).
- unpdf (MIT, bundles Mozilla pdf.js, Apache-2.0) https://github.com/unjs/unpdf: PDF text for Knowledge, previews and the page reader (`modules/files/knowledge.js`, `modules/search/reader.js`).

## Methods and prompts

- GPT Researcher (Apache-2.0) https://github.com/assafelovic/gpt-researcher: the plan, search, read, write flow of `modules/research/deep.js` follows its planner/researcher/writer split; prompts re-written, no code copied.
- karpathy/llm-council (no licence stated in the repository; README: "provided here as is for other people's inspiration") https://github.com/karpathy/llm-council: the three-stage Council method (each seat answers alone, ranks the others' anonymised answers, a chairman writes the final answer) in `modules/council/server.js` and `stages.js`. Method only: no code or prompt text copied.
- mem0 (Apache-2.0) https://github.com/mem0ai/mem0: fact extraction and add / update / ignore prompts from `mem0/configs/prompts.py` (USER_MEMORY_EXTRACTION_PROMPT, DEFAULT_UPDATE_MEMORY_PROMPT), ported, shortened and merged into one call in `modules/memory/learn.js`.

## Optional programs and sidecars (not shipped)

- Aider (Apache-2.0) https://github.com/Aider-AI/aider: optional sidecar the Code module runs if the owner installed it, pointed at the desk's router endpoint (`modules/code/server.js`); no code copied.
- Docker Engine (Apache-2.0) https://github.com/moby/moby: optional container sandbox for the Code module when Docker is running (`modules/code/sandbox.js`).
- LiteLLM (MIT, as stated for the non-enterprise code) https://github.com/BerriAI/litellm: when its proxy answers on port 4000 the Models page offers it as a Custom provider (`modules/models/server.js`).
- @modelcontextprotocol/server-filesystem (MIT) https://github.com/modelcontextprotocol/servers: reference server the owner can add (fetched with npx at run time); used by `modules/connect/real-check.mjs`.
- Ollama (MIT) https://github.com/ollama/ollama: the local model runner, used over its HTTP API (`/api/tags`, `/api/pull`, `/api/delete`, `/api/show`) by `modules/models/server.js` and the model door (`app/core/model-door.js`).
- Piper (MIT; repository archived, development moved to https://github.com/OHF-Voice/piper1-gpl which is GPL-3.0) https://github.com/rhasspy/piper: optional local text to speech in Voice, release 2023.11.14-2 binary, run as a separate program (never linked) (`modules/voice/engines.js`). Its espeak-ng data is GPL-3.0.
- SearXNG (AGPL-3.0) https://github.com/searxng/searxng: optional sidecar on the owner's PC, called only over its JSON API (`modules/search/providers.js`); no SearXNG code is copied.
- whisper.cpp (MIT) https://github.com/ggml-org/whisper.cpp: optional local speech to text in Voice, run as a separate program the owner places in a folder (`modules/voice/engines.js`).
- Activepieces (MIT outside packages/ee, which is under its own commercial licence) https://github.com/activepieces/activepieces: judged as an optional flows sidecar and dropped; no code used.

## Public APIs and data

- ntfy (Apache-2.0 / GPL-2.0 dual) https://github.com/binwiederhier/ntfy: the push protocol (plain HTTP POST to a topic, default server ntfy.sh) used by Channels (`modules/channels/ntfy.js`); no ntfy code copied.
- Telegram Bot API https://core.telegram.org/bots/api: the Telegram channel, plain HTTPS calls (`modules/channels/telegram.js`).
- Reddit API and X API (hosted services, the owner's own account keys): the posting adapters in Social (`modules/social/networks.js`).
- ElevenLabs API (hosted service, the owner's own key from the shared key store) https://elevenlabs.io/docs/api-reference: optional text to speech and speech to text in Voice (`modules/voice/hosted.js`); no code copied.
- Open-Meteo (data CC BY 4.0; server AGPL-3.0, https://github.com/open-meteo/open-meteo) https://open-meteo.com: keyless geocoding and 7-day forecast in Life (`modules/life/weather.js`).
- Frankfurter (MIT) https://github.com/lineofflight/frankfurter: keyless exchange rates (ECB data) in Life (`modules/life/server.js`).
- Wikivoyage and Wikipedia (CC BY-SA 4.0): travel text in Life, shown as sources with links (`modules/life/server.js`); Wikipedia's API is also a keyless search provider (`modules/search/providers.js`).
- OpenStreetMap (ODbL) https://www.openstreetmap.org: map links in Life.
- DuckDuckGo (HTML results page) and Hacker News search by Algolia: keyless search providers; a challenge page is never worked around (`modules/search/providers.js`).
- Serper, Brave Search, Tavily, Exa and Jina (hosted services, only with the owner's own key): keyed search providers (`modules/search/providers.js`).
- Firecrawl (hosted service, only with the owner's own key) https://firecrawl.dev: an optional second try for a page the desk's own read returned empty, Settings › Page reading (`modules/search/services.js`). Jina Reader (hosted service, https://jina.ai/reader) serves the same purpose, with or without the owner's key (`modules/search/services.js`).
- RIPEstat (RIPE NCC hosted data service) https://stat.ripe.net: the network and AS name for an address in Network (`modules/network/conn.js`, `modules/network/server.js`).
- crt.sh (public certificate logs) https://crt.sh: subdomains seen in certificate logs for a domain the owner names (`modules/network/osint.js`).
- Internet Archive Wayback Machine https://archive.org/help/wayback_api.php: earlier copies of a page for a domain the owner names (`modules/network/osint.js`).
- Shodan (hosted service, only with the owner's own key) https://developer.shodan.io/api: the subdomain list for a domain the owner names (`modules/network/osint.js`).
- GitHub (hosted service) https://github.com/agentpopulation/apdesk: the release list and the signed update download, used only when the owner checks for or installs an update (`app/core/update.js`).
- Cloudflare DNS over HTTPS, rdap.org and the IANA RDAP bootstrap: domain lookups in Network (`modules/network/lookup.js`); speed.cloudflare.com: the speed test (`modules/network/speed.js`).
- Model providers (hosted services, the owner's own keys) and the no-sign-in upstreams of the built-in Free API by Agent Population Desk (OVH AI Endpoints, Pollinations): called over their public APIs; the list is in `app/core/providers.json`, terms and limits in `modules/models/catalog.js`.
- llama.cpp (MIT) https://github.com/ggml-org/llama.cpp: the optional local model engine. Its `llama-server` program is downloaded by the owner's choice and run as a separate program on this PC (`modules/models/local-engine.js`); no llama.cpp code is copied.
- IBM Granite models in GGUF form (Apache-2.0) https://huggingface.co/ibm-granite: the local models the desk offers to download; fetched from Hugging Face by the owner's choice, not shipped.
- Node.js (MIT, with bundled third-party licences) https://nodejs.org: on Windows the installer keeps its own copy of the official build in the AP Desk folder; not shipped in the zip.
