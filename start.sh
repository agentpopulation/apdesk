#!/bin/sh
# AP Desk: one file to start the desk on Linux and macOS.
# It answers only on this computer, at http://127.0.0.1 on its own port (3445 unless another program holds it).
# Press Ctrl+C in this window to stop it.
cd "$(dirname "$0")" || exit 1

# 1. Node.js 22.13 or newer.
if ! command -v node >/dev/null 2>&1; then
  echo "AP Desk needs Node.js 22.13 or newer, and it is not installed yet."
  echo "Get it from https://nodejs.org and run this file again."
  exit 1
fi
if ! node setup/check.mjs node; then
  echo "Get Node.js 22.13 or newer from https://nodejs.org and run this file again."
  exit 1
fi

# 2. The packages. Installed once, on the first start.
if ! node setup/check.mjs packages >/dev/null 2>&1; then
  echo "First start: installing the packages AP Desk needs. This takes a minute."
  if [ -f package.json ]; then
    npm install --omit=dev --ignore-scripts --no-audit --no-fund
  else
    (cd setup && npm install --omit=dev --ignore-scripts --no-audit --no-fund && mv node_modules ../node_modules)
  fi
  if ! node setup/check.mjs packages >/dev/null 2>&1; then
    echo "The packages could not be installed. Check your internet connection and run this file again."
    exit 1
  fi
fi

# 3. The port: the remembered one, else 3445, else the next free one when another program holds it.
PORT="$(node setup/check.mjs port)" || exit 1
export APD_PORT="$PORT"
URL="http://127.0.0.1:$PORT"

open_desk() {
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  else echo "Open $URL in your browser."
  fi
}

# 4. Already running? Just open it.
if node setup/check.mjs running >/dev/null 2>&1; then
  echo "AP Desk is already running at $URL"
  open_desk
  exit 0
fi

# A proxy set in HTTPS_PROXY or HTTP_PROXY (any case) is used for the desk's own web calls (Node reads it when
# NODE_USE_ENV_PROXY is 1). This computer itself never goes through the proxy; Node reads no_proxy before NO_PROXY.
if [ -z "${NODE_USE_ENV_PROXY:-}" ] && [ -n "${HTTPS_PROXY:-}${https_proxy:-}${HTTP_PROXY:-}${http_proxy:-}" ]; then
  NODE_USE_ENV_PROXY=1
  NO_PROXY="127.0.0.1,localhost,::1${no_proxy:+,$no_proxy}${NO_PROXY:+,$NO_PROXY}"
  no_proxy="$NO_PROXY"
  export NODE_USE_ENV_PROXY NO_PROXY no_proxy
fi

# 5. Open the browser once the desk answers, and run the desk in this window.
(node setup/check.mjs wait >/dev/null 2>&1 && open_desk) &
echo "AP Desk is starting at $URL"
echo "Press Ctrl+C in this window to stop it."
while :; do
  [ -f setup/apply-update.mjs ] && node --no-warnings setup/apply-update.mjs
  node --no-warnings app/server.js
  code=$?
  [ "$code" = 75 ] || break   # 75 means the desk asked to be restarted
done
exit "$code"
