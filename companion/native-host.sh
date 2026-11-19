#!/bin/sh
# Let the Clean Ears extension start the companion by itself (Chrome native messaging).
#   companion/native-host.sh install [EXTENSION_ID] | uninstall | status
# Writes two small files:
#   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.cleanears.companion.json
#   ~/Library/Application Support/CleanEars/native_host.py (the launcher; macOS
#   won't let Chrome run programs kept in Desktop/Documents/Downloads)
# EXTENSION_ID defaults to the extension the companion is paired with.
NAME=com.cleanears.companion
DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
HERE=$(cd "$(dirname "$0")" && pwd)
HOST="$HOME/Library/Application Support/CleanEars/native_host.py"
case "$1" in
  install)
    ID="$2"
    if [ -z "$ID" ]; then
      ID=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/Library/Application Support/CleanEars/companion.json')))['pairedOrigin'].split('//')[1].strip('/'))" 2>/dev/null)
    fi
    [ -n "$ID" ] || { echo "Extension ID unknown: run the companion once with the extension, or pass the ID (chrome://extensions)."; exit 1; }
    mkdir -p "$DIR" "$(dirname "$HOST")"
    sed "s#^COMPANION_DIR = None.*#COMPANION_DIR = \"$HERE\"#" "$HERE/native_host.py" > "$HOST" && chmod +x "$HOST"
    cat > "$DIR/$NAME.json" <<JSON
{
  "name": "$NAME",
  "description": "Starts the Clean Ears companion app",
  "path": "$HOST",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ID/"]
}
JSON
    echo "Installed: Clean Ears ($ID) can now start the companion by itself."
    ;;
  uninstall)
    rm -f "$DIR/$NAME.json" "$HOST" && echo "Removed: the extension can no longer start the companion."
    ;;
  status)
    [ -f "$DIR/$NAME.json" ] && cat "$DIR/$NAME.json" || echo "Not installed."
    ;;
  *) echo "usage: companion/native-host.sh install [EXTENSION_ID] | uninstall | status"; exit 1 ;;
esac
