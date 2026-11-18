#!/bin/sh
# One-step setup for the Clean Ears companion app (roadmap step 2.3).
#   companion/install.sh [--model small.en|base.en|tiny.en]
# Creates companion/.venv (~240 MB), installs the packages, downloads the
# speech model (small.en ~500 MB) and checks it runs. Safe to run again.
set -e
cd "$(dirname "$0")"
MODEL=small.en
[ "$1" = "--model" ] && MODEL="$2"

PY=""
for p in python3.11 python3.12 python3.10; do
  if command -v "$p" >/dev/null 2>&1; then PY=$(command -v "$p"); break; fi
done
if [ -z "$PY" ]; then
  echo "Needs Python 3.10–3.12. Install it with:  brew install python@3.11"
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "Creating the Python environment with $PY…"
  "$PY" -m venv .venv
fi
echo "Installing packages…"
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt

echo "Downloading and checking the $MODEL speech model…"
.venv/bin/python server.py --check --model "$MODEL"

echo
echo "Done. Start the companion with:  companion/start.sh"
echo "Or have it start whenever you log in:  companion/login-item.sh on"
