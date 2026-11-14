#!/bin/sh
# AP Desk for Mac: double-click this file to start the desk. It runs start.sh in this folder.
cd "$(dirname "$0")" || exit 1
exec sh ./start.sh
