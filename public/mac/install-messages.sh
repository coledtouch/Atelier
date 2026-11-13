#!/bin/sh
# Atelier Messages helper for macOS: lets the Atelier Browser extension read and send texts through Messages.
# Atelier's Settings → Connections shows this command with your extension id filled in:
#   curl -fsSL https://atelier.ciprari.ai/mac/install-messages.sh | sh -s <extension-id>
# It installs into ~/Library/Application Support/Atelier and registers the helper with Chrome for that one
# extension id. Nothing runs in the background: Chrome starts the helper for each request.
set -eu

ID="${1:-}"
ORIGIN="${ATELIER_ORIGIN:-https://atelier.ciprari.ai}"
HOST_NAME="ai.ciprari.atelier.messages"

fail() { printf 'Atelier: %s\n' "$1" >&2; exit 1; }
[ "$(uname)" = "Darwin" ] || fail "this helper is for macOS."
printf '%s' "$ID" | grep -Eq '^[a-p]{32}$' || fail "pass the Atelier Browser extension id (32 letters a-p). Copy the command from Atelier Settings → Connections."

DIR="$HOME/Library/Application Support/Atelier"
mkdir -p "$DIR"
curl -fsSL "$ORIGIN/mac/atelier-messages-host.js" -o "$DIR/atelier-messages-host.js.new"
mv "$DIR/atelier-messages-host.js.new" "$DIR/atelier-messages-host.js"

# What Chrome starts is the helper itself, with osascript as its interpreter line. It used to be a two-line sh script
# that ran osascript, and macOS then held /bin/sh responsible for reading chat.db: Full Disk Access for osascript (or
# for Chrome) changed nothing, and reading texts was refused (v125).
{ printf '%s\n' '#!/usr/bin/osascript -l JavaScript'; cat "$DIR/atelier-messages-host.js"; } > "$DIR/atelier-messages-host.new"
chmod 755 "$DIR/atelier-messages-host.new"
mv "$DIR/atelier-messages-host.new" "$DIR/atelier-messages-host"

registered=0
for browser in "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Canary" "Chromium"; do
  base="$HOME/Library/Application Support/$browser"
  [ -d "$base" ] || continue
  mkdir -p "$base/NativeMessagingHosts"
  cat > "$base/NativeMessagingHosts/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Atelier Messages helper",
  "path": "$DIR/atelier-messages-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ID/"]
}
EOF
  registered=$((registered + 1))
done
[ "$registered" -gt 0 ] || fail "no Chrome found in ~/Library/Application Support."

cat <<'EOF'
Atelier Messages helper installed.

Two macOS permissions are left:
  1. Reading texts: System Settings → Privacy & Security → Full Disk Access → turn on osascript.
     To add osascript, run:  open -R /usr/bin/osascript   and drag the selected file into that list.
  2. Sending: the first time Atelier sends a text, macOS asks to let osascript control Messages. Click Allow.

For SMS (green bubbles), turn on Text Message Forwarding for this Mac on your iPhone:
Settings → Apps → Messages → Text Message Forwarding.
EOF
