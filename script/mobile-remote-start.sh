#!/bin/bash
set -euo pipefail
launchctl kickstart "gui/$(id -u)/com.stalin.opencode-remote" >/dev/null 2>&1 || launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.stalin.opencode-remote.plist"
exec /usr/local/bin/python3 "$HOME/opencode-mobile-fixed/script/mobile-remote-access.py" link
