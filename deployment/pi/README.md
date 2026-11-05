# Format server on Raspberry Pi OS

This deploys the actual Format application, not the Kodi add-on, as an unprivileged
system service. It preserves the desktop, Kodi, games and existing HDD media.
The music files stay on the HDD. Database, metadata and cover cache live under
`~/.local/share/format-pi` on the Pi's system disk. It does not copy or sync music.

## Requirements

- Raspberry Pi OS with systemd, Python 3.9+, Node **22+**, ffmpeg/ffprobe, findmnt.
- A readable **Music folder** on an already mounted HDD with a filesystem UUID.
- Run as the normal Kodi user (for example, `kodi`), not root. `sudo` is used only
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
still be checked on the actual Pi hardware. No live library migration is implied.

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

## Explicit download-only mode (optional)

The default command above remains read-only. To enable acquisition, first
separately review and install a supported provider downloader, including its
ARM64 compatibility, provider terms and your rights to download the material.
The installer does **not** download, install or run that tool. An executable
preflight proves only that a regular executable exists, not provider operation,
architecture support or licensing. Supply its actual absolute path, with no
symlink components.

Choose a **new, dedicated direct child** of your verified Music directory:

```sh
python3 deployment/pi/install.py --music-root '/verified/HDD/Music' \
  --enable-downloads --acquisition-root '/verified/HDD/Music/Format Downloads' \
  --downloader '/home/kodi/tools/provider-downloader'
# Repeat the same command with --install only after reviewing preflight.
```

Preflight creates nothing. `--install` creates that directory with fixed
`albums/` and `staging/` children plus a `.format-acquisition.json` ownership
marker recording schema version 1 and the verified filesystem UUID. Existing
unrelated directories are rejected, including ones containing music. Reinstall
requires both the retained configuration and matching marker. Paths containing
symlinks, overlapping app/state paths, missing or wrong HDDs, and split
filesystems fail closed. The installer does not mount disks, edit fstab, change
ownership, copy old media, or replace an existing library folder.

Systemd keeps all Music read-only except the dedicated acquisition directory.
This is one writable mount island so `staging/` to `albums/` publication can
use atomic rename without crossing separate systemd bind mounts. The ownership
marker is separately read-only. The application restricts work to the fixed
`albums/` and `staging/` children. Only
`albums/` is scanned; staging is excluded even after disabling downloads.
State/cache stays on the system disk. Download-only mode keeps
`FORMAT_READ_ONLY=true`; repairs, edits, retagging and deletion of existing media
remain disabled. Only explicit manual download-only jobs may run or resume on
restart. Legacy queued/resolving/running/failed jobs are preserved and stay idle;
preflight reports their count when readable, without modifying the queue.

If global Node is absent after bootstrap, the installer reuses the retained
absolute Node executable after validating it and checking Node 22+. It does not
download a replacement runtime during opt-in.

Every upgrade or reinstall requires `--enable-downloads` and both path arguments
again. Omitting them disables downloads, removes media-write allowances, and
retains acquired albums, staging, ownership information, queues and cache.
Restore download capability only with the same explicit opt-in command.
Configuration and previous service-unit backups are retained in the state
folder. On registration failure, the previous configuration is restored and the
service is stopped for review; incomplete rollback is reported explicitly.
No downloaded media is removed during rollback. For a manual rollback, stop the
service, restore the **matching config and service-unit backups**, reload systemd,
and review before starting. Restoring only an older unit/config pair can change
which acquisition paths are writable; do not mix versions.

These are isolated synthetic checks, not a claim that a provider or downloader
has been tested on a live Pi. No live HDD, provider credentials or LAN setting
is changed by repository validation.

## Health and capability contract

`GET /api/health` keeps `readOnly: true` in both Pi modes and reports:

- `capabilities`: `acquire`, `cancel`, `prioritize`, `editMetadata`,
  `deleteMedia`, and `repair`. `acquire` requires enabled download-only mode and
  infrastructure readiness. `cancel` and `prioritize` depend only on enabled
  mode, so jobs remain manageable when storage or the downloader is unavailable.
  The last three capabilities remain `false`.
- `downloads`: `enabled`, `ready`, and `reason`. The reason is `null` when ready,
  otherwise `disabled`, `unsafe_configuration`, `storage_unavailable`, or
  `downloader_unavailable`.

Readiness checks configuration, mounted storage and executable availability
only. They do not establish provider compatibility, credentials, licensing,
ARM64 execution or successful music acquisition. Real provider verification and
live deployment remain blocked until separately authorized by the user. Nothing
in the synthetic test result grants that authorization.

Runtime verifies that acquisition, albums and staging report the same nonempty,
non-root `findmnt` target, as well as the expected UUID and device. A nested bind
mount is rejected even if it reports the same device number. The Music parent's
read-only mount may differ from the single writable acquisition island.

Download opt-in requires at least **1 GiB of user-available free HDD space**.
Preflight checks the existing Music directory before creating a new acquisition
folder, or staging for an existing owned folder. The server checks this floor
before accepting, starting and publishing a job, and during its active-job
watchdog. Low space reports `storage_unavailable`; cancellation and prioritizing
remain available. This conservative floor is not an album-size guarantee and
does not reserve capacity. Failures retain staging and never delete music or
partial downloads to recover space. Disabling downloads remains possible when
the disk is full.

Cancellation waits for the entire downloader process group to stop, escalating
from TERM to KILL when needed, before releasing queue ownership or validating
files. A descendant which closes its output pipes cannot bypass that wait.
Service termination also stops the group and retains interrupted explicit jobs
for restart recovery. If shutdown cannot be verified, new acquisition is locked
pending service review; systemd's control group remains the final stop boundary.

## CI filesystem namespace verification

Both Ubuntu x86-64 and ARM64 safety jobs run
`python3 deployment/pi/namespace_check.py` separately from ordinary unit tests.
It launches a unique disposable transient systemd unit as the unprivileged CI
user, using filesystem and security properties from the actual service renderer.
Synthetic data under `RUNNER_TEMP` (or home, never PrivateTmp paths) must prove
that original Music and the ownership marker are nonwritable, state and the
acquisition island are writable, and staging-to-albums rename preserves the
inode and succeeds within a common mount target. No production unit/config is
installed, no provider runs, and only the owned transient unit/test directory
is cleaned up. Missing systemd PID 1 or required tools fails the check rather
than skipping or weakening it. A successful CI namespace check still does not
establish live Pi mount setup, provider operation or deployment authorization.
