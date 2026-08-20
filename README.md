# Format

Format is an open-source, local-first library for backing up owned physical
media while preserving the experience of choosing a complete work from a
shelf and playing it in its intended order. Records, tapes, CDs and digital
files are formats of the work—not a source for a random-track feed.

- Scans real audio metadata below `/home/jake/Music`.
- Streams audio with range request support.
- Extracts embedded cover art on demand.
- Suggests similar artists from Last.fm based on the local library.
- Refreshes its cached library snapshot every 15 minutes; page loads read the latest completed snapshot without scanning.
- Keeps Navidrome on port 4533 as the full library backend.
- Tries authorised lossless providers in quality-first order: Qobuz, Amazon,
  Tidal, then Deezer. Existing files are retained by the downloader.
- Uses MusicBrainz release groups as the release identity source. A matching
  Apple Music catalogue URL is used only as the SpotiFLAC metadata handoff;
  Spotify search is not part of the acquisition path.

Run directly:

```bash
npm start
```

Open `http://192.168.68.60:4534/`.

Container release checks build and run the same non-root image used for deployment. The image includes FFmpeg, ffprobe, and SpotiFLAC 0.7.0; `/music`, `/cache`, and `/data` must be writable by UID/GID 1000 when mounted. `SPOTIFLAC_BIN` and `SPOTIFLAC_CWD` may override the packaged downloader for a controlled deployment. The Compose profile mounts the owned music library read-write because completed acquisitions are published beneath `MUSIC_ROOT`.

Keyboard playback follows the useful YouTube conventions: `Space`/`K`
toggles playback, `J`/`L` selects the previous/next track, `M` toggles mute,
up/down changes volume, `0`–`9` seeks by percentage, `Home`/`End` seeks to the
ends, and `F` toggles fullscreen. On the Library page left/right remains
reserved for moving through Cover Flow and Enter plays the centred album.
Network interruptions retry the current track with capped backoff instead of
advancing the album. An unreadable file is retried once, then skipped so the
rest of the album can continue; the player announces either condition.

## Raspberry Pi 4B touchscreen player

The `player/rpi4` bundle configures Raspberry Pi OS Bookworm Desktop as a
full-screen Format player using the Pi's default USB or I2S DAC. See
`player/rpi4/README.md` for installation and audio-output checks. The music
library and Format service remain on this gateway.

The Metadata page links to MusicBrainz Picard Web at
`http://192.168.68.60:8086/`. A separate Picard instance checks for new album
folders every five minutes and rechecks the complete library every 24
hours. It clusters and looks up tags first, falls back to acoustic scanning,
and saves matched files only. Ambiguous files remain untouched for manual
review in Picard Web. Both Picard containers mount `/home/jake/Music`
read-write; Format and Navidrome remain read-only consumers.

## Reliability baseline

Format follows the useful core behaviours established by Lidarr, Navidrome,
MusicBrainz and Subsonic-style music servers:

- metadata-driven artist, album and track indexing;
- local search and byte-range playback;
- exact release identity through MusicBrainz;
- persistent, visible and cancellable acquisition queues;
- missing-track detection and repair eligibility;
- quality-first provider fallback without overwriting existing files;
- verified completion: a zero exit code alone never marks an album complete;
- safe file/path handling and recoverable deletion.

## Shadow library

Format keeps one persistent shadow record for every detected or requested
album. New downloads remain in isolated staging and incomplete albums remain
outside the playable carousel. An album is published only after its selected
MusicBrainz release has an authoritative track manifest and every manifest
entry maps to a validated local file.

The Downloads page reads the shadow records directly and exposes their track
manifests. Legacy track totals are never sufficient proof for deletion, and
duplicate removal is report-only until two files are confirmed to represent
the same MusicBrainz recording. Automatic shadow repair is controlled by
`SHADOW_REPAIR_ENABLED=true`; leave it disabled while auditing a migrated
library.

MusicBrainz calls are proactively paced above one request per second and use a
versioned application User-Agent. Future quality upgrades must stage and inspect
a candidate before replacing a lower-quality file.

## Tests

```bash
npm run verify
```

The suite uses a temporary music library and mock downloader. It never modifies
the live library. It covers metadata scanning, inconsistent provider tags,
incomplete albums, full and ranged playback, path traversal rejection, album
archives, one-click acquisition, false-success rejection, queue cancellation,
rescanning, and unknown-target handling.

Feature references:

- https://lidarr.audio/
- https://www.navidrome.org/docs/usage/library/tagging/
- https://musicbrainz.org/doc/MusicBrainz_API
- https://docs.subsonic.org/pages/features.jsp
