#!/bin/sh
# Start the Clean Ears companion app (Ctrl-C to quit).
#   companion/start.sh [--model small.en|base.en|tiny.en] [--reset-pairing]
cd "$(dirname "$0")" || exit 1
if [ ! -x .venv/bin/python ]; then
  echo "Not installed yet – running companion/install.sh first."
  ./install.sh || exit 1
fi
exec .venv/bin/python server.py "$@"
