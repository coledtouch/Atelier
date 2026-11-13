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

cat > "$DIR/atelier-messages-host" <<EOF
#!/bin/sh
exec /usr/bin/osascript -l JavaScript "$DIR/atelier-messages-host.js"
EOF
chmod 755 "$DIR/atelier-messages-host"

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
  1. Reading texts: System Settings → Privacy & Security → Full Disk Access → turn on osascript and Google Chrome.
     To add osascript, run:  open -R /usr/bin/osascript   and drag the selected file into that list.
     Then quit Chrome (Cmd-Q) and reopen it.
  2. Sending: the first time Atelier sends a text, macOS asks to let Chrome control Messages. Click OK.

For SMS (green bubbles), turn on Text Message Forwarding for this Mac on your iPhone:
Settings → Apps → Messages → Text Message Forwarding.
EOF
