# Format server on Raspberry Pi OS

This deploys the actual Format application, not the Kodi add-on, as an unprivileged
system service. It preserves the desktop, Kodi, games and existing HDD media.
The music files stay on the HDD. Database, metadata and cover cache live under
`~/.local/share/format-pi` on the Pi's system disk. It does not copy or sync music.

## Requirements

- Raspberry Pi OS with systemd, Python 3.9+, Node **22+**, ffmpeg/ffprobe, findmnt.
- A readable **Music folder** on an already mounted HDD with a filesystem UUID.
- Run as the normal Kodi user (for Jacob, `jake`), not root. `sudo` is used only
  to install the generated system service and start/enable it.
- The application checkout must remain in place. Do not install from `/tmp` or
  delete the extracted source directory afterwards.

Check the actual Pi first:

```sh
node --version
findmnt -o TARGET,SOURCE,FSTYPE,UUID
lsblk -f
```

Do not guess `/media/pi`, the drive name, or the music folder. If music has not
been copied yet, create the intended folder yourself on the mounted HDD. The
installer never mounts, reformats, changes fstab or fixes ownership recursively.
It stops if Node is too old rather than changing repositories or upgrading the OS.

From this checkout, substitute the **verified** existing music folder:

```sh
python3 deployment/pi/install.py --music-root '/actual/HDD/Music'
python3 deployment/pi/install.py --music-root '/actual/HDD/Music' --install
```

The first command only checks and displays the plan. The second installs and
enables `format-pi.service` to start on boot. If the HDD is desktop-automounted,
it may become available only after desktop login; the service retries every 30
seconds. It checks the filesystem UUID before startup and before scans/streaming,
so a missing or different drive does not become an empty replacement library.
No boot-mount settings are changed.

## Kodi and indexing

Set Aperture's Format add-on **server URL** to `http://127.0.0.1:4534`.
There is no separate server machine to configure. Verify:

```sh
systemctl status format-pi --no-pager
curl -f http://127.0.0.1:4534/api/health
```

This deployment is deliberately **read-only for media**, enforced both in the
application and with systemd filesystem restrictions. Existing metadata
corrections, acquisitions, Picard automation, retagging and deletion are disabled.
Do not use the repository's old gateway Compose configuration on the Pi.

Format's existing publication policy is unchanged: fresh albums are catalogued
but do not enter the playable library until an authoritative track manifest
validates them. Nothing is mislabeled complete to make an empty shelf disappear.
To identify copied albums, run this metadata-only reconciliation:

```sh
curl -f -X POST http://127.0.0.1:4534/api/rescan
curl -f -X POST http://127.0.0.1:4534/api/shadow-albums/reconcile
```

Identification uses MusicBrainz, is rate-limited, and can take time or leave
ambiguous/incomplete albums unpublished. It does not download missing music or
rewrite tags. Pending records can be inspected at `/api/shadow-albums`.
Scheduled scans pick up later copied music every 15 minutes; repeat reconciliation
for new albums. Kodi's local music browser remains available independently.

## Network scope and operations

Only `127.0.0.1:4534` is opened. No firewall ports, authentication credentials,
public exposure or LAN write API are added. This is sufficient for Kodi on this
Pi but **not phone browser access**. Authenticated LAN access needs a separate
reviewed configuration; do not change HOST to `0.0.0.0` on an untrusted network.
YouTube casting is a separate receiver, not this server.

```sh
journalctl -u format-pi -n 80 --no-pager
sudo systemctl stop format-pi
sudo systemctl disable format-pi
```

Stopping/disabling does not remove media or server state. Previous configuration
files are kept as `config-backup-*.json` on reinstall. For rollback stop the
service before restoring a backup or removing the service unit.

## Verification limits

The repository tests use synthetic temporary audio and state, never the user's
HDD. They verify media bytes are unchanged by read-only scans, queued jobs remain
idle, write APIs are blocked, and publication rules remain strict. Python tests
verify unit hardening, path escaping and wrong/missing HDD rejection. Actual Pi
systemd startup, filesystem/permissions, HDMI, and Kodi client connection must
still be checked on Jacob's hardware. No live library migration is implied.

## Bootstrap when Node is absent

On 64-bit ARM, the user-run helper downloads **Node 22.23.4** from the official
nodejs.org distribution and verifies a pinned SHA256. It stores that runtime
under `~/.local/share/format-runtime`, not in `/usr`, and leaves any global Node
installation unchanged. It offers a normal interactive distro ffmpeg install
only if required. Then it installs the same protected server service above:

```sh
sh deployment/pi/setup.sh '/verified/HDD/Music'
```

The executable path is pinned into the service configuration. Source, runtime,
state and cache stay on the Pi's system disk; media remains on the external HDD.
The runtime checksum was obtained from the official versioned SHASUMS256.txt.
