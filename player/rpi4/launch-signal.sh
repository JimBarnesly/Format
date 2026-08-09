#!/usr/bin/env bash
set -euo pipefail

config_file="${XDG_CONFIG_HOME:-$HOME/.config}/signal-player/player.env"
if [[ -r "$config_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$config_file"
  set +a
fi

signal_server_url="${SIGNAL_SERVER_URL:-http://192.168.68.60:4534/#library}"
chromium_bin="$(command -v chromium || command -v chromium-browser)"

if command -v xset >/dev/null 2>&1 && [[ -n "${DISPLAY:-}" ]]; then
  xset s off || true
  xset -dpms || true
  xset s noblank || true
fi

if [[ -n "${SIGNAL_AUDIO_SINK_MATCH:-}" ]] && command -v wpctl >/dev/null 2>&1; then
  sink_id="$(wpctl status -n | awk -v needle="$SIGNAL_AUDIO_SINK_MATCH" '
    BEGIN { IGNORECASE=1; in_sinks=0 }
    /Sinks:/ { in_sinks=1; next }
    /Sources:/ { in_sinks=0 }
    in_sinks && index($0, needle) { if (match($0, /[0-9]+\./)) { print substr($0, RSTART, RLENGTH-1); exit } }
  ')"
  [[ -z "$sink_id" ]] || wpctl set-default "$sink_id"
fi

server_root="${signal_server_url%%#*}"
for _ in $(seq 1 60); do
  if curl --fail --silent --max-time 2 "$server_root/api/bootstrap" >/dev/null; then break; fi
  sleep 2
done

exec "$chromium_bin" \
  --kiosk \
  --no-first-run \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI \
  --autoplay-policy=no-user-gesture-required \
  --overscroll-history-navigation=0 \
  --start-fullscreen \
  "$signal_server_url"
