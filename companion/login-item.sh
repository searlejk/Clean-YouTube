#!/bin/sh
# Start the Clean Ears companion app automatically when you log in.
#   companion/login-item.sh on | off | status
# Uses a per-user LaunchAgent (no admin rights); logs go to
# ~/Library/Logs/CleanEars/companion.log.
LABEL=com.cleanears.companion
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR=$(cd "$(dirname "$0")" && pwd)
LOG="$HOME/Library/Logs/CleanEars"

plist() {
  cat <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$DIR/start.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG/companion.log</string>
  <key>StandardErrorPath</key><string>$LOG/companion.log</string>
</dict>
</plist>
XML
}

case "$1" in
  on)
    [ -x "$DIR/.venv/bin/python" ] || { echo "Run companion/install.sh first."; exit 1; }
    mkdir -p "$HOME/Library/LaunchAgents" "$LOG"
    plist > "$PLIST"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "On: the companion starts now and at every login."
    ;;
  off)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    rm -f "$PLIST" && echo "Off: the companion no longer starts at login."
    ;;
  status)
    if [ -f "$PLIST" ]; then echo "Start at login: on"; else echo "Start at login: off"; fi
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state =|pid =" || echo "Not running from login."
    ;;
  print) plist ;;
  *) echo "usage: companion/login-item.sh on | off | status"; exit 1 ;;
esac
