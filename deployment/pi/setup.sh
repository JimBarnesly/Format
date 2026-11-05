#!/bin/sh
set -eu
# User-run setup for a 64-bit Raspberry Pi. No mount or media modifications.
[ "$(id -u)" -ne 0 ] || { echo 'Run as the normal Pi user, not sudo.' >&2; exit 1; }
[ "$#" -eq 1 ] || { echo 'Usage: sh deployment/pi/setup.sh /verified/HDD/Music' >&2; exit 1; }
[ -d "$1" ] || { echo 'The music folder does not exist. No changes made.' >&2; exit 1; }
case "$(uname -m)" in aarch64|arm64) ;; *) echo 'This bootstrap requires 64-bit ARM Raspberry Pi OS.' >&2; exit 1;; esac
for tool in python3 curl tar sha256sum findmnt systemctl; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  echo 'Installing ffmpeg from the configured OS repositories. Review the package plan.'
  sudo apt-get update
  sudo apt-get install --no-remove ffmpeg
fi
version=v22.23.4
runtime="$HOME/.local/share/format-runtime/node-$version-linux-arm64"
if [ ! -x "$runtime/bin/node" ]; then
  mkdir -p "$HOME/.local/share/format-runtime"
  work=$(mktemp -d "$HOME/.local/share/format-runtime/.download.XXXXXX")
  trap 'rm -rf "$work"' EXIT HUP INT TERM
  curl -fL --connect-timeout 15 --max-time 300 "https://nodejs.org/dist/$version/node-$version-linux-arm64.tar.xz" -o "$work/node.tar.xz"
  printf '%s  %s\n' 6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b "$work/node.tar.xz" | sha256sum -c -
  tar -xJf "$work/node.tar.xz" -C "$work"
  [ ! -e "$runtime" ] || { echo 'Runtime target exists but is incomplete; leaving it unchanged.' >&2; exit 1; }
  mv "$work/node-$version-linux-arm64" "$runtime"
fi
[ "$("$runtime/bin/node" --version)" = "$version" ] || { echo 'Unexpected Node runtime version.' >&2; exit 1; }
export PATH="$runtime/bin:$PATH"
python3 "$script_dir/install.py" --music-root "$1" --install
