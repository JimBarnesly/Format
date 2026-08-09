#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -m)" != "aarch64" && "$(uname -m)" != "armv7l" ]]; then
  echo "Warning: this installer is intended for Raspberry Pi OS on a Pi 4B." >&2
fi

signal_server_url="${1:-http://192.168.68.60:4534/#library}"
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/signal-player"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/signal-player"
autostart_dir="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1 || {
  echo "Chromium is required. On Raspberry Pi OS run: sudo apt install chromium" >&2
  exit 1
}

install -d -m 0755 "$install_dir" "$config_dir" "$autostart_dir"
install -m 0755 "$script_dir/launch-signal.sh" "$install_dir/launch-signal.sh"

cat >"$config_dir/player.env" <<EOF
SIGNAL_SERVER_URL=$signal_server_url
# Optional PipeWire sink name fragment, for example: USB Audio DAC
SIGNAL_AUDIO_SINK_MATCH=
EOF

sed "s|@LAUNCHER@|$install_dir/launch-signal.sh|g" "$script_dir/signal-player.desktop.in" \
  >"$autostart_dir/signal-player.desktop"
chmod 0644 "$autostart_dir/signal-player.desktop"

echo "Format Player installed for $USER."
echo "Server: $signal_server_url"
echo "Audio outputs:"
if command -v wpctl >/dev/null 2>&1; then wpctl status | sed -n '/Sinks:/,/Sources:/p'; else aplay -l || true; fi
echo "Set your USB/I2S DAC as the default output, then log out and back in or reboot."
