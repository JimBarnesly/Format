# Gateway music browser

Stremio-style local frontend for the gateway music library.

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

## Reliability baseline

Signal follows the useful core behaviours established by Lidarr, Navidrome,
MusicBrainz and Subsonic-style music servers:

- metadata-driven artist, album and track indexing;
- local search and byte-range playback;
- exact release identity through MusicBrainz;
- persistent, visible and cancellable acquisition queues;
- missing-track detection and repair eligibility;
- quality-first provider fallback without overwriting existing files;
- verified completion: a zero exit code alone never marks an album complete;
- safe file/path handling and recoverable deletion.

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
