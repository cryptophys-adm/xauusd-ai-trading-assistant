#!/bin/sh
# The OANDA feed terminal's start script (/opt/mt5-oanda/run.sh, run by mt5-oanda.service as its user). Bridge 1.8.2+
# (feed incident 2026-11-27): the terminal ALWAYS starts with a /config file, so its chart opens with the OmegaFeed EA
# after any restart (a reboot, a unit restart, a crash):
#   - the login file while it still holds a password (the bridge just applied a login), else
#   - the credential-free start file the bridge keeps (startup.ini: no login, no password; the saved account logs in
#     by itself; the EA on the feed's symbol, algo trading off).
# Paths are the runbook's (docs/RUNBOOK_OF1_FEED.md); keep the existing script's wine command line if it differs and
# change only the /config choice. Never prints a file's contents.
set -eu
export WINEPREFIX="${WINEPREFIX:-/opt/mt5-oanda/prefix}"
export DISPLAY="${DISPLAY:-:2}"
T="${TERMINAL_DIR:-/opt/mt5-oanda/prefix/drive_c/Program Files/OANDA MetaTrader 5}"
LOGIN_INI="${LOGIN_INI:-/opt/mt5-oanda/login.ini}"
STARTUP_INI="${STARTUP_INI:-/opt/mt5-oanda/startup.ini}"
# Z: is the prefix's view of /, so /opt/mt5-oanda/x.ini is Z:\opt\mt5-oanda\x.ini.
winpath() { printf 'Z:%s' "$1" | tr '/' '\\'; }
if [ -f "$LOGIN_INI" ] && grep -Eq '^Password=.+' "$LOGIN_INI"; then
  CONFIG="$LOGIN_INI"
elif [ -f "$STARTUP_INI" ]; then
  CONFIG="$STARTUP_INI"
else
  CONFIG=""
fi
if [ -n "$CONFIG" ]; then
  exec wine "$T/terminal64.exe" /portable "/config:$(winpath "$CONFIG")"
fi
echo "feed-run: no login file with a password and no startup.ini: starting without /config (the EA will not attach)" >&2
exec wine "$T/terminal64.exe" /portable
