#!/bin/sh
# Start the Clean Ears companion app. First run: creates companion/.venv and
# installs packages (~240 MB); the speech model (~500 MB) downloads on first use.
cd "$(dirname "$0")" || exit 1
if [ ! -x .venv/bin/python ]; then
  PY=$(command -v python3.11 || command -v python3)
  "$PY" -m venv .venv && .venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -q -r requirements.txt || exit 1
fi
exec .venv/bin/python server.py "$@"
