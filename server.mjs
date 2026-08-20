import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { publishAlbumDirectory } from "./album-publisher.mjs";
import { quarantinePreview } from "./staging-quarantine.mjs";
import { readStagingInventory } from "./acquisition-inventory.mjs";
import { selectOriginalReleaseGroup } from "./release-metadata.mjs";
import { openPublishedMedia } from "./published-media-policy.mjs";
import {
  authoritativeExpectedTrackCount,
  authoritativeManifestEntries,
  authoritativePosition,
  persistedShadowManifest,
  publishedTrackIdsForAlbum,
  retainedExpectedTrackCount,
  safeManifestEntries,
  shadowPublicationState
} from "./shadow-publication-policy.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(process.env.MUSIC_ROOT || "/home/jake/Music");
const downloadRoot = resolve(process.env.DOWNLOAD_ROOT || join(root, "SpotiFLAC"));
const publicDir = resolve("public");
const cacheDir = resolve(process.env.CACHE_DIR || "/home/jake/.cache/gateway-music-browser");
const dataDir = resolve(process.env.DATA_DIR || "/home/jake/.local/share/gateway-music-browser");
const discoveryFile = join(dataDir, "discovery.json");
const acquisitionFile = join(dataDir, "acquisitions.json");
const approvalFile = join(dataDir, "download-approvals.json");
const managedAlbumFile = join(dataDir, "managed-albums.json");
const shadowAlbumFile = join(dataDir, "shadow-albums.json");
const librarySnapshotFile = join(dataDir, "library-snapshot.json");
const cataloguedLibrarySnapshotFile = join(dataDir, "catalogued-library-snapshot.json");
const trashRoot = resolve(process.env.TRASH_ROOT || join(dataDir, "trash"));
const stagingRoot = resolve(process.env.DOWNLOAD_STAGING_ROOT || join(dataDir, "download-staging"));
const rateLimitFile = join(dataDir, "lookup-rate-limit.json");
const firstReleaseYearFile = join(dataDir, "first-release-years.json");
const metadataCorrectionsFile = resolve(process.env.METADATA_CORRECTIONS_FILE || "metadata-corrections.json");
const port = Number(process.env.PORT || 4534);
const testMode = process.env.NODE_ENV === "test";
const spotiflacBin = process.env.SPOTIFLAC_BIN || "spotiflac";
const spotiflacCwd = resolve(process.env.SPOTIFLAC_CWD || process.cwd());
const libraryScanIntervalMs = Math.max(60_000, Number(process.env.LIBRARY_SCAN_INTERVAL_MS || 15 * 60 * 1000));
const libraryMaintenanceIntervalMs = Math.max(60_000, Number(process.env.LIBRARY_MAINTENANCE_INTERVAL_MS || 24 * 60 * 60 * 1000));
const libraryProbeConcurrency = Math.max(1, Math.min(12, Number(process.env.LIBRARY_PROBE_CONCURRENCY || 6)));
const acquisitionStallTimeoutMs = Math.max(testMode ? 250 : 60_000, Number(process.env.ACQUISITION_STALL_TIMEOUT_MS || 3 * 60 * 1000));
const acquisitionMaxAttempts = Math.max(1, Number(process.env.ACQUISITION_MAX_ATTEMPTS || 3));
const shadowRepairEnabled = process.env.SHADOW_REPAIR_ENABLED === "true";
const audioExtensions = new Set([".flac", ".mp3", ".m4a", ".ogg", ".opus", ".wav"]);
const catalogueReleases = new Map();
const spotifyResolutionCache = new Map([
  ["eda7c3b6-ab1f-38d8-8685-af46f2341596", "https://open.spotify.com/album/0OxSLFlIitRpIT2s9CIjoX"],
  ["a45cf6c9-cbac-4ab4-a702-7becee40a8e8", "https://open.spotify.com/album/6QVBWX8iAeZTlbGSfRVfYC"],
  ["18037a41-2695-3a8f-a732-f6653a7f125b", "https://open.spotify.com/album/3MANoCcmaHWeXSuWiO3iVo"]
]);
const acquisitionState = new Map();
const acquisitionQueue = [];
const repairApprovals = new Map();
const managedAlbums = new Set();
const shadowAlbums = new Map();
const firstReleaseYears = new Map();
let activeAcquisitionId = null;
let activeAcquisitionProcess = null;
let initialLibraryScanComplete = false;
let acquisitionSavePromise = Promise.resolve();
let shadowSavePromise = Promise.resolve();
let lookupRetryTimer = null;
let acquisitionRetryTimer = null;
let approvalAnalysisPromise = null;
let shadowReconciliationPromise = null;
let lastMusicBrainzRequestAt = 0;

const albumKey = (artist, title) => `${normalized(artist)}\0${normalized(canonicalAlbumTitle(title))}`;
const acquisitionPriorities = { manual: 10, approved_repair: 20, automatic_repair: 30, discovery: 40 };

function terminateProcessTree(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") child.kill("SIGTERM");
  }
}

let cataloguedLibrary = { albums: [], tracks: [], updatedAt: null };
let library = { albums: [], tracks: [], updatedAt: null };
let featuredIndex = -1;
let recommendations = [];
let discoveries = [];
let libraryScanPromise = null;
const catalogueCache = new Map();
const recommendationCache = new Map();
const recommendationCacheTtl = 24 * 60 * 60 * 1000;
let lookupRateLimitUntil = 0;
let lookupRateLimitStrikes = 0;

function retryAfterMs(response) {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = new Date(value).getTime();
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function responseError(response, label) {
  const error = new Error(`${label} returned HTTP ${response.status}`);
  error.status = response.status;
  error.retryAfterMs = retryAfterMs(response);
  return error;
}

async function fetchWithRetry(url, options = {}, label = new URL(url).hostname) {
  const { timeoutMs, ...requestOptions } = options;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...requestOptions,
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : requestOptions.signal
      });
      if (response.ok) return response;
      throw responseError(response, label);
    } catch (error) {
      lastError = error;
      if (error.status === 429) {
        triggerLookupRateLimit(error.retryAfterMs);
        throw error;
      }
      const transient = error.status === 429
        || (Number.isInteger(error.status) && error.status >= 500)
        || /timeout|aborted|fetch failed/i.test(error.message);
      if (!transient || attempt === 2) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000 * (2 ** attempt)));
    }
  }
  throw lastError;
}

function lookupRateLimitState() {
  const remainingMs = Math.max(0, lookupRateLimitUntil - Date.now());
  return { active: remainingMs > 0, until: remainingMs > 0 ? new Date(lookupRateLimitUntil).toISOString() : null, remainingMs };
}

function triggerLookupRateLimit(serverRetryAfterMs = null) {
  lookupRateLimitStrikes += 1;
  const fallbackMs = Math.min(8 * 60 * 60 * 1000, 2 * 60 * 60 * 1000 * (2 ** (lookupRateLimitStrikes - 1)));
  const cooldownMs = Number.isFinite(serverRetryAfterMs) && serverRetryAfterMs > 0 ? serverRetryAfterMs : fallbackMs;
  lookupRateLimitUntil = Math.max(lookupRateLimitUntil, Date.now() + cooldownMs);
  scheduleLookupRetry();
  void mkdir(dataDir, { recursive: true })
    .then(() => writeFile(rateLimitFile, `${JSON.stringify({ schemaVersion: 1, until: new Date(lookupRateLimitUntil).toISOString(), strikes: lookupRateLimitStrikes }, null, 2)}\n`, "utf8"))
    .catch((error) => console.error("Could not persist lookup rate limit:", error.message));
}

function scheduleLookupRetry() {
  if (lookupRetryTimer) clearTimeout(lookupRetryTimer);
  const remainingMs = lookupRateLimitState().remainingMs;
  if (remainingMs <= 0) {
    lookupRetryTimer = null;
    void processAcquisitionQueue();
    return;
  }
  lookupRetryTimer = setTimeout(() => {
    lookupRetryTimer = null;
    void processAcquisitionQueue();
  }, remainingMs + 100);
  lookupRetryTimer.unref();
}

async function loadLookupRateLimit() {
  try {
    const saved = JSON.parse(await readFile(rateLimitFile, "utf8"));
    const until = new Date(saved.until || 0).getTime();
    lookupRateLimitUntil = Number.isFinite(until) && until > Date.now() ? until : 0;
    lookupRateLimitStrikes = Number.isInteger(saved.strikes) ? Math.max(0, saved.strikes) : 0;
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load lookup rate limit:", error.message);
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJsonRequest(request, maximumBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw Object.assign(new Error("Request is too large."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON request."), { status: 400 });
  }
}

function safeMusicPath(id) {
  const candidate = resolve(root, id);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path));
    else if (audioExtensions.has(extname(entry.name).toLowerCase())) found.push(path);
  }
  return found;
}

async function probe(path) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration,size,bit_rate:format_tags=artist,album_artist,album,title,date,originaldate,original_date,originalyear,musicbrainz_releasegroupid,musicbrainz_trackid,track,tracktotal,disc,disctotal,genre,url:stream=codec_name,codec_type,sample_rate,bits_per_raw_sample,bits_per_sample,bit_rate",
    "-of", "json", path
  ], { maxBuffer: 1024 * 1024 });
  const data = JSON.parse(stdout);
  const fileStat = await stat(path);
  const tags = data.format?.tags || {};
  const audioStream = (data.streams || []).find((stream) => stream.codec_type === "audio") || {};
  const value = (name, fallback = "") => tags[name] || tags[name.toUpperCase()] || fallback;
  return {
    id: relative(root, path),
    title: value("title", path.split(sep).at(-1).replace(extname(path), "")),
    artist: value("artist", "Unknown artist").replaceAll(";", ", "),
    albumArtist: value("album_artist", value("artist", "Unknown artist")).replaceAll(";", ", "),
    album: value("album", "Unknown album"),
    year: String(value("originaldate", value("original_date", value("originalyear", value("date"))))).slice(0, 4),
    releaseYear: String(value("date")).slice(0, 4),
    musicBrainzReleaseGroupId: value("musicbrainz_releasegroupid"),
    musicBrainzRecordingId: value("musicbrainz_trackid"),
    track: Number.parseInt(value("track", "0"), 10) || 0,
    trackTotal: Number.parseInt(value("tracktotal", "0"), 10) || 0,
    disc: Number.parseInt(value("disc", "1"), 10) || 1,
    discTotal: Number.parseInt(value("disctotal", "1"), 10) || 1,
    sourceUrl: value("url"),
    genre: value("genre").replaceAll(";", " · "),
    duration: Math.round(Number(data.format?.duration || 0)),
    codec: audioStream.codec_name || "",
    sampleRate: Number(audioStream.sample_rate) || 0,
    bitDepth: Number(audioStream.bits_per_raw_sample || audioStream.bits_per_sample) || 0,
    bitRate: Number(audioStream.bit_rate || data.format?.bit_rate) || 0,
    fileSize: Number(data.format?.size) || 0,
    fileMtimeMs: fileStat.mtimeMs
  };
}

function canonicalAlbumTitle(title) {
  return String(title || "Unknown album")
    .replace(/\s*[([](?:\d{4}\s+)?(?:re)?master(?:ed)?(?:\s+version)?[^)\]]*[)\]]\s*$/i, "")
    .replace(/\s*[([](?:deluxe|expanded|anniversary|special)\s+(?:edition|version)[^)\]]*[)\]]\s*$/i, "")
    .trim() || String(title || "Unknown album");
}

function canonicalTrackTitle(title) {
  return String(title || "")
    .replace(/\s*[-–—]\s*[^\n]*(?:original\s+mix|(?:re)?master(?:ed)?)[^\n]*$/i, "")
    .replace(/\s*[([][^\])]*(?:original\s+mix|false\s+start|(?:re)?master(?:ed)?)[^\])]*[\])]\s*$/i, "")
    .trim();
}

function trackQuality(track) {
  const lossless = new Set(["flac", "alac", "wav", "ape", "wv"]).has(track.codec) ? 1 : 0;
  return [lossless, track.bitDepth, track.sampleRate, track.bitRate, track.fileSize];
}

function compareTrackQuality(left, right) {
  const leftScore = trackQuality(left);
  const rightScore = trackQuality(right);
  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) return rightScore[index] - leftScore[index];
  }
  return left.id.localeCompare(right.id);
}

async function removeDuplicateTracks(tracks) {
  // Duplicate removal is intentionally report-only. Track numbers are not
  // recording identities: damaged tags can assign two different songs to the
  // same slot. A later shadow-library reconciliation may trash a file only
  // after both candidates map to the same MusicBrainz recording.
  return tracks;
  /* legacy unsafe implementation retained temporarily for migration review
  const releaseCoverage = new Map();
  for (const track of tracks) {
    const family = `${normalized(track.albumArtist)}\0${normalized(canonicalAlbumTitle(track.album))}`;
    const release = normalized(track.album);
    const key = `${family}\0${release}`;
    if (!releaseCoverage.has(key)) releaseCoverage.set(key, new Set());
    releaseCoverage.get(key).add(normalized(track.title));
  }
  const preferredRelease = new Map();
  for (const [key, titles] of releaseCoverage) {
    const parts = key.split("\0");
    const family = parts.slice(0, 2).join("\0");
    const current = preferredRelease.get(family);
    if (!current || titles.size > current.coverage) preferredRelease.set(family, { release: parts[2], coverage: titles.size });
  }
  const groups = new Map();
  for (const track of tracks) {
    // An album slot is disc + track number. Title spelling and file duration
    // are attributes of that slot, not separate track identities.
    const slot = track.track > 0 ? `number:${track.track}` : `title:${normalized(track.title)}`;
    const key = [normalized(track.albumArtist), normalized(canonicalAlbumTitle(track.album)), track.disc, slot].join("\0");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(track);
  }
  const removed = new Set();
  for (const candidates of groups.values()) {
    if (candidates.length < 2) continue;
    const family = `${normalized(candidates[0].albumArtist)}\0${normalized(canonicalAlbumTitle(candidates[0].album))}`;
    const preferred = preferredRelease.get(family)?.release;
    const ranked = [...candidates].sort((left, right) => {
      const leftPreferred = normalized(left.album) === preferred ? 1 : 0;
      const rightPreferred = normalized(right.album) === preferred ? 1 : 0;
      return rightPreferred - leftPreferred || compareTrackQuality(left, right);
    });
    const keeper = ranked[0];
    for (const duplicate of ranked.slice(1)) {
      const source = safeMusicPath(duplicate.id);
      if (!source || !existsSync(source)) continue;
      await moveToSignalTrash(source);
      removed.add(duplicate.id);
      console.log(`Moved duplicate to Signal trash: ${duplicate.id}; kept ${keeper.id}`);
    }
  }
  return tracks.filter((track) => !removed.has(track.id)); */
}

function applyAlbumFolderConsensus(tracks) {
  const folders = new Map();
  for (const track of tracks) {
    const folder = dirname(track.id);
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(track);
  }
  for (const folderTracks of folders.values()) {
    if (folderTracks.length < 3) continue;
    const artists = new Set(folderTracks.map((track) => normalized(track.albumArtist)));
    if (artists.size !== 1) continue;
    const counts = new Map();
    for (const track of folderTracks) {
      const title = canonicalAlbumTitle(track.album);
      const key = normalized(title);
      const entry = counts.get(key) || { title, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
    const winner = [...counts.values()].sort((left, right) => right.count - left.count)[0];
    if (!winner || winner.count < 3 || winner.count / folderTracks.length < .6) continue;
    for (const track of folderTracks) track.album = winner.title;
  }
  return tracks;
}

async function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function loadMetadataCorrections() {
  try {
    const parsed = JSON.parse(await readFile(metadataCorrectionsFile, "utf8"));
    return Array.isArray(parsed.corrections) ? parsed.corrections : [];
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load metadata corrections:", error.message);
    return [];
  }
}

async function applyMetadataCorrections(paths) {
  const corrections = await loadMetadataCorrections();
  if (!corrections.length) return [];
  const pending = [];
  for (const correction of corrections) {
    const destination = safeMusicPath(correction.relativePath || "");
    if (destination && existsSync(destination)) {
      try {
        const track = await probe(destination);
        const matches = (!correction.artist || track.artist === correction.artist)
          && (!correction.albumArtist || track.albumArtist === correction.albumArtist)
          && (!correction.album || track.album === correction.album)
          && (!correction.title || track.title === correction.title)
          && (!correction.date || track.year === String(correction.date).slice(0, 4))
          && (!correction.track || track.track === Number(correction.track))
          && (!correction.trackTotal || track.trackTotal === Number(correction.trackTotal))
          && (!correction.disc || track.disc === Number(correction.disc))
          && (!correction.discTotal || track.discTotal === Number(correction.discTotal));
        if (matches) continue;
      } catch {
        // Hash the library below if the intended destination cannot be read.
      }
    }
    pending.push(correction);
  }
  if (!pending.length) return [];
  const byHash = new Map(pending.map((correction) => [correction.sha256, correction]));
  const directSources = new Map(pending
    .filter((correction) => correction.sourceRelativePath)
    .map((correction) => [correction.sourceRelativePath, correction]));
  const requiresLibraryHashSearch = pending.some((correction) => !correction.sourceRelativePath);
  const applied = [];
  for (const source of paths) {
    const sourceRelativePath = relative(root, source);
    const directCorrection = directSources.get(sourceRelativePath);
    if (!directCorrection && !requiresLibraryHashSearch) continue;
    const correction = byHash.get(await sha256(source));
    if (!correction) continue;
    const destination = safeMusicPath(correction.relativePath || "");
    if (!destination) {
      console.error(`Ignoring unsafe metadata correction destination: ${correction.relativePath}`);
      continue;
    }
    await mkdir(join(destination, ".."), { recursive: true });
    const temporary = `${destination}.metadata-fix-${process.pid}${extname(destination)}`;
    const metadata = [
      ["artist", correction.artist], ["album_artist", correction.albumArtist],
      ["album", correction.album], ["title", correction.title], ["date", correction.date],
      ["track", correction.track], ["tracktotal", correction.trackTotal],
      ["disc", correction.disc], ["disctotal", correction.discTotal]
    ].filter(([, value]) => value !== undefined && value !== null && value !== "");
    await execFileAsync("ffmpeg", ["-loglevel", "error", "-i", source, "-map", "0:a", "-c", "copy", "-map_metadata", "0",
      ...metadata.flatMap(([name, value]) => ["-metadata", `${name}=${value}`]), "-y", temporary]);
    if (existsSync(destination) && resolve(source) !== resolve(destination)) {
      const duplicateDir = join(dataDir, "metadata-duplicates");
      await mkdir(duplicateDir, { recursive: true });
      await rename(source, join(duplicateDir, `${correction.sha256}-${source.split(sep).at(-1)}`));
      await rename(temporary, destination);
    } else {
      await rename(temporary, destination);
      if (resolve(source) !== resolve(destination) && existsSync(source)) {
        const duplicateDir = join(dataDir, "metadata-originals");
        await mkdir(duplicateDir, { recursive: true });
        await rename(source, join(duplicateDir, `${correction.sha256}-${source.split(sep).at(-1)}`));
      }
    }
    applied.push({ source: relative(root, source), destination: relative(root, destination), reason: correction.reason || "Configured correction" });
  }
  return applied;
}

async function performLibraryScan() {
  let paths = await walk(root);
  const corrections = await applyMetadataCorrections(paths);
  if (corrections.length) {
    console.log(`Applied ${corrections.length} metadata correction${corrections.length === 1 ? "" : "s"}.`);
    paths = await walk(root);
  }
  const tracksByIndex = new Array(paths.length);
  const cachedTracks = new Map(cataloguedLibrary.tracks.map((track) => [track.id, track]));
  let nextPathIndex = 0;
  await Promise.all(Array.from({ length: Math.min(libraryProbeConcurrency, paths.length) }, async () => {
    while (nextPathIndex < paths.length) {
      const index = nextPathIndex++;
      try {
        const id = relative(root, paths[index]);
        const cached = cachedTracks.get(id);
        const fileStat = cached?.fileMtimeMs ? await stat(paths[index]) : null;
        tracksByIndex[index] = cached && fileStat?.mtimeMs === cached.fileMtimeMs && fileStat.size === cached.fileSize
          ? cached
          : await probe(paths[index]);
      } catch (error) {
        console.error(`Skipping unreadable audio file: ${paths[index]}`, error.message);
      }
    }
  }));
  const tracks = applyAlbumFolderConsensus(await removeDuplicateTracks(tracksByIndex.filter(Boolean)));
  const grouped = new Map();
  for (const track of tracks) {
    // Reissues often carry different DATE tags track-by-track. Treat artist +
    // album as the library identity so one physical album is not split across
    // several cards merely because providers supplied inconsistent years.
    const canonicalTitle = canonicalAlbumTitle(track.album);
    const key = `${normalized(track.albumArtist)}\0${normalized(canonicalTitle)}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        id: encodeURIComponent(key),
        artist: track.albumArtist,
        title: canonicalTitle,
        year: track.year,
        genre: track.genre,
        trackIds: [],
        sourceUrl: track.sourceUrl,
        duration: 0
      });
    }
    const album = grouped.get(key);
    album.trackIds.push(track.id);
    if (!album.year || (track.year && track.year < album.year)) album.year = track.year;
    if (!album.sourceUrl && track.sourceUrl) album.sourceUrl = track.sourceUrl;
    album.duration += track.duration;
  }
  const albums = [...grouped.values()].map((album) => {
    const albumTracks = tracks.filter((track) => album.trackIds.includes(track.id));
    const discs = new Map();
    const discTotalCounts = new Map();
    for (const track of albumTracks) {
      discTotalCounts.set(track.discTotal, (discTotalCounts.get(track.discTotal) || 0) + 1);
      if (!discs.has(track.disc)) discs.set(track.disc, { totals: new Map(), present: new Set() });
      const disc = discs.get(track.disc);
      if (track.trackTotal) disc.totals.set(track.trackTotal, (disc.totals.get(track.trackTotal) || 0) + 1);
      if (track.track) disc.present.add(track.track);
    }
    const mostCommon = (counts, fallback) => [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] || fallback;
    const expectedDiscCount = mostCommon(discTotalCounts, 1);
    const missingTracks = [];
    for (const [discNumber, disc] of discs) {
      disc.expected = mostCommon(disc.totals, Math.max(0, ...disc.present));
      for (let trackNumber = 1; trackNumber <= disc.expected; trackNumber += 1) {
        if (!disc.present.has(trackNumber)) missingTracks.push(`${discNumber}:${trackNumber}`);
      }
    }
    const missingDiscs = Math.max(0, expectedDiscCount - discs.size);
    return {
      ...album,
      year: firstReleaseYears.get(albumKey(album.artist, album.title)) || album.year,
      expectedTracks: [...discs.values()].reduce((total, disc) => total + disc.expected, 0),
      incomplete: missingTracks.length > 0 || missingDiscs > 0,
      missingTracks,
      missingDiscs,
      trackIds: album.trackIds.sort((a, b) => {
      const left = tracks.find((track) => track.id === a)?.track || 0;
      const right = tracks.find((track) => track.id === b)?.track || 0;
      return left - right;
      })
    };
  });
  cataloguedLibrary = { albums, tracks, updatedAt: new Date().toISOString() };
  library = await reconcileShadowAlbums(cataloguedLibrary);
  await mkdir(dataDir, { recursive: true });
  const cataloguedTemporary = `${cataloguedLibrarySnapshotFile}.tmp`;
  await writeFile(cataloguedTemporary, `${JSON.stringify({ schemaVersion: 1, library: cataloguedLibrary }, null, 2)}\n`, "utf8");
  await rename(cataloguedTemporary, cataloguedLibrarySnapshotFile);
  const snapshotTemporary = `${librarySnapshotFile}.tmp`;
  await writeFile(snapshotTemporary, `${JSON.stringify({ schemaVersion: 1, library }, null, 2)}\n`, "utf8");
  await rename(snapshotTemporary, librarySnapshotFile);
  await prepareFeaturedRecommendations();
}

async function loadFirstReleaseYears() {
  try {
    const saved = JSON.parse(await readFile(firstReleaseYearFile, "utf8"));
    for (const [key, year] of Object.entries(saved.years || {})) {
      if (/^\d{4}$/.test(String(year))) firstReleaseYears.set(key, String(year));
    }
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load first-release years:", error.message);
  }
}

async function saveFirstReleaseYears() {
  await mkdir(dataDir, { recursive: true });
  const temporary = `${firstReleaseYearFile}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, years: Object.fromEntries(firstReleaseYears) }, null, 2)}\n`, "utf8");
  await rename(temporary, firstReleaseYearFile);
}

async function enrichFirstReleaseYears({ revalidate = false } = {}) {
  if (testMode) return;
  let changed = 0;
  for (const album of library.albums) {
    const key = albumKey(album.artist, album.title);
    if (!revalidate && firstReleaseYears.has(key)) continue;
    try {
      const albumTracks = album.trackIds.map(getLibraryTrack).filter(Boolean);
      const knownGroupId = albumTracks.find((track) => track.musicBrainzReleaseGroupId)?.musicBrainzReleaseGroupId;
      const result = knownGroupId
        ? await musicBrainz(`/release-group/${knownGroupId}?inc=artist-credits&fmt=json`)
        : await musicBrainz(`/release-group?query=${encodeURIComponent(`releasegroup:${album.title} AND artist:${album.artist}`)}&fmt=json&limit=8`);
      const group = knownGroupId ? result : selectOriginalReleaseGroup(result["release-groups"], album);
      const year = group?.["first-release-date"]?.slice(0, 4);
      if (!/^\d{4}$/.test(year || "")) continue;
      if (firstReleaseYears.get(key) === year) continue;
      firstReleaseYears.set(key, year);
      album.year = year;
      changed += 1;
      if (changed % 20 === 0) await saveFirstReleaseYears();
    } catch (error) {
      console.error(`Could not resolve first release year for ${album.artist} — ${album.title}:`, error.message);
      if (error.status === 429) break;
    }
  }
  if (!changed) return;
  await saveFirstReleaseYears();
  const temporary = `${librarySnapshotFile}.tmp`;
  library.updatedAt = new Date().toISOString();
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, library }, null, 2)}\n`, "utf8");
  await rename(temporary, librarySnapshotFile);
  console.log(`Resolved original release years for ${changed} album${changed === 1 ? "" : "s"}.`);
}

async function loadLibrarySnapshot() {
  try {
    const saved = JSON.parse(await readFile(librarySnapshotFile, "utf8"));
    if (saved.library?.albums && saved.library?.tracks) library = saved.library;
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load library snapshot:", error.message);
  }
}

async function loadCataloguedLibrarySnapshot() {
  try {
    const saved = JSON.parse(await readFile(cataloguedLibrarySnapshotFile, "utf8"));
    if (saved.library?.albums && saved.library?.tracks) cataloguedLibrary = saved.library;
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load catalogued library snapshot:", error.message);
  }
}

async function scanLibrary() {
  if (libraryScanPromise) return libraryScanPromise;
  libraryScanPromise = performLibraryScan();
  try {
    await libraryScanPromise;
    return library;
  } finally {
    libraryScanPromise = null;
  }
}

async function trashTrack(id) {
  const track = library.tracks.find((item) => item.id === id);
  const path = track && safeMusicPath(track.id);
  if (!path || !existsSync(path)) throw new Error("Track not found");
  await moveToSignalTrash(path);
  await scanLibrary();
  return { trashed: 1, library };
}

async function trashAlbum(id) {
  const album = library.albums.find((item) => item.id === id);
  if (!album) throw new Error("Album not found");
  const paths = album.trackIds.map(safeMusicPath);
  if (paths.some((path) => !path || !existsSync(path))) throw new Error("One or more album tracks were not found");
  for (const path of paths) await moveToSignalTrash(path);
  await scanLibrary();
  return { trashed: paths.length, library };
}

async function moveToSignalTrash(path) {
  const relativePath = relative(root, path);
  if (!relativePath || relativePath.startsWith("..") || resolve(root, relativePath) !== path) {
    throw new Error("Unsafe trash path");
  }
  const parsedExtension = extname(relativePath);
  const stem = parsedExtension ? relativePath.slice(0, -parsedExtension.length) : relativePath;
  const suffix = `${Date.now()}-${createHash("sha256").update(relativePath).digest("hex").slice(0, 8)}`;
  const destination = join(trashRoot, `${stem}.${suffix}${parsedExtension}`);
  await mkdir(dirname(destination), { recursive: true });
  await rename(path, destination);
  return destination;
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", "\"")
    .replaceAll("&nbsp;", " ");
}

function normalized(value) {
  return value.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function safeDownloadName(value) {
  return value.replace(/[^\p{L}\p{N} ._()-]+/gu, "").trim().replace(/\s+/g, " ") || "album";
}

async function spotifyAnonymousToken() {
  const seedAlbumUrl = spotifyResolutionCache.values().next().value;
  const seedAlbumId = seedAlbumUrl?.match(/\/album\/([A-Za-z0-9]+)/)?.[1];
  if (!seedAlbumId) throw new Error("No Spotify seed album is configured");
  const html = await fetch(`https://open.spotify.com/embed/album/${seedAlbumId}`, {
    headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(5000)
  }).then((result) => {
    if (!result.ok) throw new Error(`Spotify embed returned HTTP ${result.status}`);
    return result.text();
  });
  const encodedState = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/)?.[1];
  if (!encodedState) throw new Error("Spotify embed did not include session data");
  const token = JSON.parse(encodedState).props?.pageProps?.state?.settings?.session?.accessToken;
  if (!token) throw new Error("Spotify embed did not include an access token");
  return token;
}

function downloadAlbum(id, response) {
  const album = library.albums.find((item) => item.id === id);
  if (!album) return sendJson(response, 404, { error: "Owned album not found" });
  const files = album.trackIds.map(safeMusicPath);
  if (files.some((file) => !file || !existsSync(file))) {
    return sendJson(response, 409, { error: "One or more album tracks are missing" });
  }
  const archiveName = safeDownloadName(`${album.artist} - ${album.title}${album.year ? ` (${album.year})` : ""}.tar.gz`);
  response.writeHead(200, {
    "content-type": "application/gzip",
    "content-disposition": `attachment; filename="${archiveName}"`,
    "cache-control": "no-store"
  });
  const relativeFiles = files.map((file) => relative(root, file));
  const archive = spawn("tar", ["-czf", "-", "-C", root, "--", ...relativeFiles], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  archive.stdout.pipe(response);
  archive.stderr.on("data", (chunk) => console.error(`Album archive error: ${chunk}`));
  archive.on("error", (error) => {
    console.error("Could not create album archive:", error);
    if (!response.headersSent) sendJson(response, 500, { error: "Could not create album archive" });
    else response.destroy(error);
  });
}

async function resolveSpotifyAlbum(release) {
  if (spotifyResolutionCache.has(release.id)) return spotifyResolutionCache.get(release.id);
  if (lookupRateLimitState().active) throw new Error("Album lookup rate limit is active. Retry after the countdown.");
  const temporaryLookupFailures = [];
  const trackMatch = String(release.sourceUrl || "").match(/^https:\/\/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
  if (trackMatch) {
    try {
      const html = await fetch(`https://open.spotify.com/embed/track/${trackMatch[1]}`, {
        headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" }
      }).then((result) => {
        if (!result.ok) throw responseError(result, "Spotify embed");
        return result.text();
      });
      const encodedState = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/)?.[1];
      if (!encodedState) throw new Error("Spotify embed did not include session data");
      const state = JSON.parse(encodedState);
      const token = state.props?.pageProps?.state?.settings?.session?.accessToken;
      if (!token) throw new Error("Spotify embed did not include an access token");
      const track = await fetch(`https://api.spotify.com/v1/tracks/${trackMatch[1]}`, {
        headers: { authorization: `Bearer ${token}` }
      }).then((result) => {
        if (!result.ok) throw responseError(result, "Spotify track lookup");
        return result.json();
      });
      const albumUrl = track.album?.external_urls?.spotify;
      if (albumUrl && normalized(track.album.name) === normalized(release.title)) {
        spotifyResolutionCache.set(release.id, albumUrl);
        return albumUrl;
      }
    } catch (error) {
      console.error(`Could not derive the Spotify album from ${release.sourceUrl}: ${error.message}`);
      if (error.status === 429) triggerLookupRateLimit(error.retryAfterMs);
    }
  }
  try {
    const token = await spotifyAnonymousToken();
    const searchUrl = new URL("https://api.spotify.com/v1/search");
    searchUrl.searchParams.set("q", `album:"${release.title}" artist:"${release.artist}"`);
    searchUrl.searchParams.set("type", "album");
    searchUrl.searchParams.set("limit", "10");
    const result = await fetch(searchUrl, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000)
    }).then((response) => {
      if (!response.ok) throw responseError(response, "Spotify search");
      return response.json();
    });
    const exact = result.albums?.items?.find((album) =>
      normalized(album.name) === normalized(release.title)
      && album.artists?.some((artist) => normalized(artist.name) === normalized(release.artist))
      && (!release.year || String(album.release_date || "").startsWith(String(release.year)))
    );
    if (exact?.external_urls?.spotify) {
      spotifyResolutionCache.set(release.id, exact.external_urls.spotify);
      return exact.external_urls.spotify;
    }
  } catch (error) {
    console.error(`Spotify catalogue lookup failed: ${error.message}`);
    if (error.status === 429) triggerLookupRateLimit(error.retryAfterMs);
    if (/HTTP (403|429|5\d\d)|timeout|aborted/i.test(error.message)) temporaryLookupFailures.push(error.message);
  }
  if (lookupRateLimitState().active) throw new Error("Album lookup rate limit is active. Retry after the countdown.");
  const query = `site:open.spotify.com/album "${release.title}" "${release.artist}"`;
  const endpoints = [
    "https://lite.duckduckgo.com/lite/?q=",
    "https://html.duckduckgo.com/html/?q=",
    "https://search.brave.com/search?q="
  ];
  const urls = [];
  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt < 2 && urls.length === 0; attempt++) {
      let html;
      try {
        html = await fetch(`${endpoint}${encodeURIComponent(query)}`, {
          headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" },
          signal: AbortSignal.timeout(5000)
        }).then((result) => {
          if (!result.ok) throw responseError(result, new URL(endpoint).hostname);
          return result.text();
        });
      } catch (error) {
        console.error(`Album lookup endpoint failed (${new URL(endpoint).hostname}, attempt ${attempt + 1}): ${error.message}`);
        if (error.status === 429) triggerLookupRateLimit(error.retryAfterMs);
        if (/HTTP (403|429|5\d\d)|timeout|aborted/i.test(error.message)) temporaryLookupFailures.push(error.message);
        if (attempt === 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
        continue;
      }
      let decodedHtml = html.replaceAll("&amp;", "&");
      try {
        decodedHtml = decodeURIComponent(decodedHtml.replaceAll("%25", "%"));
      } catch {
        // Search result pages can contain unrelated, malformed percent escapes.
      }
      urls.push(
        ...[...decodedHtml.matchAll(/https:\/\/open\.spotify\.com\/album\/[A-Za-z0-9]+/g)].map((match) => match[0]),
        ...[...html.matchAll(/uddg=([^&"]+)/g)].map((match) => decodeURIComponent(match[1]))
      );
      if (urls.length === 0 && attempt === 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
      }
    }
    if (urls.length) break;
  }
  const albumUrls = urls.filter((url) => /^https:\/\/open\.spotify\.com\/album\/[A-Za-z0-9]+/.test(url));
  const candidates = [...new Set(albumUrls)];
  if (!candidates.length && temporaryLookupFailures.length) {
    throw new Error("Album lookup providers are temporarily rate-limited or unavailable. Retry later.");
  }
  if (!candidates.length) throw new Error("No exact Spotify album page was found.");
  const expected = normalized(release.title);
  let compatible = null;
  for (const candidate of candidates.slice(0, 10)) {
    try {
      const embed = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(candidate)}`).then((result) => {
        if (!result.ok) throw new Error(`Spotify validation returned HTTP ${result.status}`);
        return result.json();
      });
      const actual = normalized(embed.title || "");
      if (actual === expected) {
        spotifyResolutionCache.set(release.id, candidate);
        return candidate;
      }
      if (!compatible && (actual.includes(expected) || expected.includes(actual))) compatible = candidate;
    } catch {
      // Try the next search result.
    }
  }
  if (!compatible) throw new Error("Search results did not contain the exact Spotify album.");
  spotifyResolutionCache.set(release.id, compatible);
  return compatible;
}

function refreshQueuePositions() {
  acquisitionQueue.sort((leftId, rightId) => {
    const left = acquisitionState.get(leftId);
    const right = acquisitionState.get(rightId);
    return (left?.priority || 99) - (right?.priority || 99)
      || new Date(left?.queuedAt || 0) - new Date(right?.queuedAt || 0);
  });
  for (const state of acquisitionState.values()) {
    state.queuePosition = state.status === "queued" ? acquisitionQueue.indexOf(state.id) + 1 : 0;
  }
}

async function saveRepairPolicy() {
  await mkdir(dataDir, { recursive: true });
  const approvalsTemporary = `${approvalFile}.tmp`;
  const managedTemporary = `${managedAlbumFile}.tmp`;
  await writeFile(approvalsTemporary, `${JSON.stringify({ schemaVersion: 1, items: [...repairApprovals.values()] }, null, 2)}\n`, "utf8");
  await writeFile(managedTemporary, `${JSON.stringify({ schemaVersion: 1, albums: [...managedAlbums] }, null, 2)}\n`, "utf8");
  await rename(approvalsTemporary, approvalFile);
  await rename(managedTemporary, managedAlbumFile);
}

async function loadRepairPolicy() {
  try {
    const saved = JSON.parse(await readFile(approvalFile, "utf8"));
    for (const item of Array.isArray(saved.items) ? saved.items : []) {
      if (item.id && item.artist && item.title) repairApprovals.set(item.id, item);
    }
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load repair approvals:", error.message);
  }
  try {
    const saved = JSON.parse(await readFile(managedAlbumFile, "utf8"));
    for (const key of Array.isArray(saved.albums) ? saved.albums : []) {
      const [artist, title] = String(key).split("\0");
      if (artist && title) managedAlbums.add(albumKey(artist, title));
    }
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load managed albums:", error.message);
  }
}

function shadowAlbumId(artist, title) {
  return createHash("sha256").update(albumKey(artist, title)).digest("hex").slice(0, 24);
}

async function saveShadowAlbums() {
  const snapshot = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    albums: [...shadowAlbums.values()].map((album) => structuredClone(album))
  };
  shadowSavePromise = shadowSavePromise.then(async () => {
    await mkdir(dataDir, { recursive: true });
    const temporary = `${shadowAlbumFile}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(temporary, shadowAlbumFile);
  }).catch((error) => console.error("Could not save shadow albums:", error.message));
  return shadowSavePromise;
}

async function loadShadowAlbums() {
  try {
    const saved = JSON.parse(await readFile(shadowAlbumFile, "utf8"));
    for (const album of Array.isArray(saved.albums) ? saved.albums : []) {
      if (album.id && album.artist && album.title) shadowAlbums.set(album.id, album);
    }
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load shadow albums:", error.message);
  }
}

async function reconcileShadowAlbums(scanned) {
  const seen = new Set();
  for (const album of scanned.albums) {
    const id = shadowAlbumId(album.artist, album.title);
    seen.add(id);
    const existing = shadowAlbums.get(id) || {};
    const now = new Date().toISOString();
    const localTracks = album.trackIds.map((trackId) => scanned.tracks.find((track) => track.id === trackId)).filter(Boolean);
    const localManifest = localTracks
      .sort((left, right) => left.disc - right.disc || left.track - right.track || left.title.localeCompare(right.title))
      .map((track) => ({
        disc: track.disc,
        position: track.track,
        title: track.title,
        recordingId: null,
        localTrackId: track.id,
        quality: { codec: track.codec, bitDepth: track.bitDepth, sampleRate: track.sampleRate, bitRate: track.bitRate },
        status: "local_unverified"
      }));
    const authoritativeUsed = new Set();
    const authoritativeManifest = existing.authoritative
      ? authoritativeManifestEntries(existing.manifest)?.map((entry) => {
        const local = localTracks.find((track) => !authoritativeUsed.has(track.id) && entry.recordingId && track.musicBrainzRecordingId === entry.recordingId)
          || localTracks.find((track) => !authoritativeUsed.has(track.id) && track.disc === entry.disc && track.track === entry.position
            && normalized(canonicalTrackTitle(track.title)) === normalized(canonicalTrackTitle(entry.title)))
          || localTracks.find((track) => !authoritativeUsed.has(track.id)
            && normalized(canonicalTrackTitle(track.title)) === normalized(canonicalTrackTitle(entry.title)));
        if (local) authoritativeUsed.add(local.id);
        return { ...entry, localTrackId: local?.id || null, status: local ? "validated" : "missing" };
      })
      : null;
    const manifest = persistedShadowManifest({
      authoritative: existing.authoritative,
      authoritativeManifest,
      localManifest
    });
    const publication = shadowPublicationState({
      existing,
      authoritativeManifest,
      albumIncomplete: album.incomplete,
      testMode
    });
    shadowAlbums.set(id, {
      ...existing,
      schemaVersion: 1,
      id,
      artist: album.artist,
      title: album.title,
      originalReleaseYear: album.year || null,
      source: publication.source,
      status: publication.status,
      published: publication.published,
      localAlbumId: album.id,
      expectedTrackCount: existing.authoritative ? existing.expectedTrackCount : album.expectedTracks,
      localTrackCount: album.trackIds.length,
      missingTracks: [...album.missingTracks],
      missingDiscs: album.missingDiscs,
      manifest,
      firstSeenAt: existing.firstSeenAt || now,
      lastScannedAt: now,
      lastError: existing.lastError || null
    });
  }
  for (const [id, album] of shadowAlbums) {
    if (seen.has(id)) continue;
    const acquisition = [...acquisitionState.values()].find((state) =>
      albumKey(state.artist, state.title) === albumKey(album.artist, album.title));
    const status = acquisition?.status === "queued" ? "retry_wait"
      : acquisition?.status === "resolving" ? "identifying"
        : acquisition?.status === "running" ? "acquiring"
          : acquisition?.status === "cancelled" ? "cancelled"
            : acquisition?.status === "failed" ? "needs_attention"
              : "missing_local_files";
    shadowAlbums.set(id, {
      ...album,
      status,
      published: false,
      lastError: acquisition?.status === "failed" || acquisition?.status === "cancelled"
        ? acquisition.message || album.lastError || null
        : status === "missing_local_files" ? "No local files or active acquisition remain for this album." : null,
      lastScannedAt: new Date().toISOString()
    });
  }
  await saveShadowAlbums();
  return publishedLibraryFrom(scanned);
}

function publishedLibraryFrom(scanned) {
  const recordsByAlbumId = new Map([...shadowAlbums.values()].map((record) => [record.localAlbumId, record]));
  const publishedAlbums = scanned.albums.flatMap((album) => {
    const record = recordsByAlbumId.get(album.id);
    const trackIds = publishedTrackIdsForAlbum(record, album.trackIds);
    return trackIds.length ? [{ ...album, trackIds }] : [];
  });
  const publishedTrackIds = new Set(publishedAlbums.flatMap((album) => album.trackIds));
  return {
    albums: publishedAlbums,
    tracks: scanned.tracks.filter((track) => publishedTrackIds.has(track.id)),
    updatedAt: scanned.updatedAt
  };
}

async function refreshPublishedLibrary() {
  library = publishedLibraryFrom(cataloguedLibrary);
  const temporary = `${librarySnapshotFile}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, library }, null, 2)}\n`, "utf8");
  await rename(temporary, librarySnapshotFile);
  await prepareFeaturedRecommendations();
}

async function identifyShadowAlbum(id) {
  const record = shadowAlbums.get(id);
  if (!record) throw Object.assign(new Error("Shadow album not found."), { status: 404 });
  const localAlbum = cataloguedLibrary.albums.find((album) => album.id === record.localAlbumId);
  if (!localAlbum) throw new Error("No local files remain for this album.");
  const localTracks = localAlbum.trackIds.map((trackId) => cataloguedLibrary.tracks.find((track) => track.id === trackId)).filter(Boolean);
  const wasPublished = record.published;
  record.status = "identifying";
  record.lastError = null;
  await saveShadowAlbums();
  try {
    const groupMatches = (item) => normalized(canonicalAlbumTitle(item.title)) === normalized(canonicalAlbumTitle(record.title))
      && (item["artist-credit"] || []).some((credit) => normalized(credit.artist?.name) === normalized(record.artist));
    const search = await musicBrainz(`/release-group?query=${encodeURIComponent(`releasegroup:${record.title} AND artist:${record.artist}`)}&fmt=json&limit=10`);
    const groups = (search["release-groups"] || []).filter(groupMatches);
    const specialEditionWanted = /\blive\b|compilation|remix/i.test(record.title);
    const group = [...groups].sort((left, right) => {
      const leftSpecial = specialEditionWanted ? 0 : (left["secondary-types"] || []).some((type) => /live|compilation|remix/i.test(type)) ? 1 : 0;
      const rightSpecial = specialEditionWanted ? 0 : (right["secondary-types"] || []).some((type) => /live|compilation|remix/i.test(type)) ? 1 : 0;
      return leftSpecial - rightSpecial
        || String(left["first-release-date"] || "9999").localeCompare(String(right["first-release-date"] || "9999"));
    })[0];
    if (!group?.id) throw new Error("MusicBrainz could not identify the album release group confidently.");
    const releasesResponse = await musicBrainz(`/release?release-group=${group.id}&inc=recordings+media+artist-credits&fmt=json&limit=100`);
    const localTitles = new Set(localTracks.map((track) => normalized(canonicalTrackTitle(track.title))));
    const candidates = (releasesResponse.releases || []).filter((release) => (release.media || []).some((medium) => medium.tracks?.length));
    const releaseTracks = (release) => (release.media || []).flatMap((medium) => medium.tracks || []);
    const editionPenalty = (release) => /deluxe|expanded|anniversary|box|super deluxe/i.test(`${release.title} ${release.disambiguation || ""}`) ? 100 : 0;
    const localDiscCount = Math.max(1, ...localTracks.map((track) => track.disc || 1));
    const score = (release) => {
      const tracks = releaseTracks(release);
      const referenceTitles = new Set(tracks.map((track) => normalized(canonicalTrackTitle(track.recording?.title || track.title))));
      const overlap = [...localTitles].filter((title) => referenceTitles.has(title)).length;
      const discCount = (release.media || []).length;
      const expansionPenalty = discCount > localDiscCount ? (discCount - localDiscCount) * 250 : 0;
      return overlap * 20 - Math.abs(tracks.length - localTracks.length) * 8 - editionPenalty(release) - expansionPenalty
        + (release.country === "NZ" ? 2 : 0);
    };
    const selected = [...candidates].sort((left, right) => score(right) - score(left)
      || String(left.date || "9999").localeCompare(String(right.date || "9999")))[0];
    if (!selected || score(selected) < Math.max(20, localTracks.length * 5)) {
      throw new Error("No MusicBrainz release had enough track-title overlap to select safely.");
    }
    const used = new Set();
    const manifest = (selected.media || []).flatMap((medium, mediumIndex) => (medium.tracks || []).map((track, trackIndex) => {
      const title = track.recording?.title || track.title || `Track ${trackIndex + 1}`;
      const recordingId = track.recording?.id || null;
      const local = localTracks.find((candidate) => !used.has(candidate.id) && recordingId
        && candidate.musicBrainzRecordingId === recordingId)
        || localTracks.find((candidate) => !used.has(candidate.id)
          && candidate.disc === (Number(medium.position) || mediumIndex + 1)
          && candidate.track === (Number(track.position) || trackIndex + 1)
          && normalized(canonicalTrackTitle(candidate.title)) === normalized(canonicalTrackTitle(title)))
        || localTracks.find((candidate) => !used.has(candidate.id)
          && normalized(canonicalTrackTitle(candidate.title)) === normalized(canonicalTrackTitle(title)));
      if (local) used.add(local.id);
      return {
        disc: authoritativePosition(medium.position),
        position: authoritativePosition(track.position),
        title,
        recordingId,
        localTrackId: local?.id || null,
        quality: local ? { codec: local.codec, bitDepth: local.bitDepth, sampleRate: local.sampleRate, bitRate: local.bitRate } : null,
        status: local ? "validated" : "missing"
      };
    }));
    const expectedTrackCount = authoritativeExpectedTrackCount(selected.media);
    const publication = shadowPublicationState({
      existing: { ...record, authoritative: true, expectedTrackCount },
      authoritativeManifest: manifest,
      albumIncomplete: false,
      testMode
    });
    Object.assign(record, {
      authoritative: true,
      releaseGroupId: group.id,
      selectedReleaseId: selected.id,
      selectedReleaseTitle: selected.title,
      selectedReleaseCountry: selected.country || null,
      originalReleaseYear: group["first-release-date"]?.slice(0, 4) || record.originalReleaseYear,
      expectedTrackCount: retainedExpectedTrackCount(expectedTrackCount, record.expectedTrackCount),
      localTrackCount: localTracks.length,
      manifest,
      status: publication.status,
      published: publication.published,
      lastReconciledAt: new Date().toISOString(),
      lastError: null
    });
    await saveShadowAlbums();
    return record;
  } catch (error) {
    record.status = wasPublished ? "legacy_published_needs_attention" : "needs_attention";
    record.published = wasPublished;
    record.lastError = error.message;
    record.lastReconciledAt = new Date().toISOString();
    await saveShadowAlbums();
    throw error;
  }
}

function reconcileShadowBatch() {
  if (shadowReconciliationPromise) return shadowReconciliationPromise;
  shadowReconciliationPromise = (async () => {
    for (const record of [...shadowAlbums.values()].filter((album) => !album.authoritative && !album.published)) {
      try {
        await identifyShadowAlbum(record.id);
      } catch (error) {
        console.error(`Shadow identification failed for ${record.artist} — ${record.title}:`, error.message);
      }
    }
    await refreshPublishedLibrary();
  })().finally(() => { shadowReconciliationPromise = null; });
  return shadowReconciliationPromise;
}

function queueNextShadowTrack(record) {
  const missing = record.manifest?.find((track) => track.status === "missing");
  if (!missing || !record.authoritative) return null;
  const decisionKey = `${missing.disc}:${missing.position}`;
  const id = `shadow-track:${record.id}:${decisionKey}`;
  const busy = [...acquisitionState.values()].find((state) =>
    ["queued", "resolving", "running"].includes(state.status)
    && albumKey(state.artist, state.title) === albumKey(record.artist, record.title));
  if (busy) return busy;
  const state = queueAlbum(id, {
    id,
    artist: record.artist,
    title: record.title,
    year: record.originalReleaseYear,
    musicBrainzId: record.releaseGroupId,
    selectedReleaseId: record.selectedReleaseId
  }, "automatic_repair");
  state.missingTracks = [decisionKey];
  state.repairMode = "track";
  record.status = "queued";
  record.acquisitionId = id;
  void saveShadowAlbums();
  void saveAcquisitions();
  return state;
}

async function maintainShadowAlbums() {
  for (const record of shadowAlbums.values()) {
    if (!record.authoritative && !record.published) {
      try { await identifyShadowAlbum(record.id); } catch { continue; }
    }
    if (record.authoritative && !record.published) queueNextShadowTrack(record);
  }
  await refreshPublishedLibrary();
}

function saveAcquisitions() {
  const snapshot = [...acquisitionState.values()].map((state) => ({
    ...state,
    release: catalogueReleases.get(state.id) || state.release
  }));
  acquisitionSavePromise = acquisitionSavePromise.then(async () => {
    await mkdir(dataDir, { recursive: true });
    const temporary = `${acquisitionFile}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, items: snapshot }, null, 2)}\n`, "utf8");
    await rename(temporary, acquisitionFile);
  }).catch((error) => console.error("Could not save acquisition queue:", error.message));
  return acquisitionSavePromise;
}

function pruneAcquisitionHistory(limit = 20) {
  const terminal = [...acquisitionState.values()]
    .filter((state) => ["complete", "failed", "cancelled"].includes(state.status))
    .sort((left, right) => new Date(right.finishedAt || right.queuedAt || 0) - new Date(left.finishedAt || left.queuedAt || 0));
  for (const state of terminal.slice(limit)) acquisitionState.delete(state.id);
}

function clearAcquisitionHistory() {
  let removed = 0;
  for (const [id, state] of acquisitionState) {
    if (!["complete", "failed", "cancelled"].includes(state.status)) continue;
    acquisitionState.delete(id);
    removed += 1;
  }
  void saveAcquisitions();
  return removed;
}

async function loadAcquisitions() {
  try {
    const saved = JSON.parse(await readFile(acquisitionFile, "utf8"));
    const cancelledAlbumKeys = new Set((Array.isArray(saved.items) ? saved.items : [])
      .filter((item) => item.status === "cancelled" && item.automaticRepairSuppressed !== false)
      .map((item) => `${normalized(item.artist)}\0${normalized(item.title)}`));
    for (const savedState of Array.isArray(saved.items) ? saved.items : []) {
      const { release, ...state } = savedState;
      if (!state.id || !release?.artist || !release?.title) continue;
      catalogueReleases.set(state.id, release);
      if (["queued", "resolving", "running"].includes(state.status)) {
        state.status = "queued";
        state.message = "Recovered after service restart.";
        state.startedAt = null;
        state.finishedAt = null;
        delete state.cancelRequested;
        delete state.timeoutRequested;
        acquisitionQueue.push(state.id);
      } else if (state.status === "failed"
        && /rate limit|rate-limited|No exact Spotify album page/i.test(state.message || "")
        && !cancelledAlbumKeys.has(`${normalized(state.artist)}\0${normalized(state.title)}`)) {
        state.status = "queued";
        state.message = "Waiting for album lookup rate limit.";
        state.startedAt = null;
        state.finishedAt = null;
        acquisitionQueue.push(state.id);
      }
      acquisitionState.set(state.id, state);
    }
    refreshQueuePositions();
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load acquisition queue:", error.message);
  }
}

function recoverApprovedDiscoveries() {
  for (const item of discoveries.filter((entry) => entry.status === "approved")) {
    const alreadyOwned = library.albums.some((album) =>
      normalized(album.artist) === normalized(item.artist)
      && normalized(album.title) === normalized(item.title)
    );
    if (alreadyOwned || acquisitionState.has(item.id)) continue;
    console.log(`Recovering approved discovery: ${item.artist} — ${item.title}`);
    queueAlbum(item.id, catalogueReleases.get(item.id), "discovery");
  }
}

function finishAcquisition(state) {
  activeAcquisitionId = null;
  state.queuePosition = 0;
  const shadowId = shadowAlbumId(state.artist, state.title);
  const shadow = shadowAlbums.get(shadowId);
  if (shadow && state.status !== "complete") {
    shadow.status = state.status === "queued" ? "retry_wait" : state.status === "cancelled" ? "cancelled" : "needs_attention";
    shadow.lastError = state.status === "queued" ? null : state.message;
    shadow.lastAttemptAt = new Date().toISOString();
    void saveShadowAlbums();
  }
  pruneAcquisitionHistory();
  refreshQueuePositions();
  void saveAcquisitions();
  void processAcquisitionQueue();
}

function albumIsCompleteInLibrary(state) {
  return library.albums.some((album) =>
    !album.incomplete
    && normalized(album.artist) === normalized(state.artist)
    && normalized(album.title) === normalized(state.title)
  );
}

function reconcileCompletedAcquisitions() {
  for (const state of acquisitionState.values()) {
    if (state.status !== "complete" || albumIsCompleteInLibrary(state)) continue;
    const release = catalogueReleases.get(state.id);
    if (!release || acquisitionQueue.includes(state.id)) continue;
    state.status = "queued";
    state.message = "Previous download produced no complete album; retrying.";
    state.progress = 0;
    state.startedAt = null;
    state.finishedAt = null;
    acquisitionQueue.push(state.id);
  }
  refreshQueuePositions();
  void saveAcquisitions();
  void processAcquisitionQueue();
}

async function resolveMusicBrainzAlbumSource(release) {
  if (testMode && process.env.TEST_ACQUISITION_SOURCE_URL) {
    release.sourceUrl = process.env.TEST_ACQUISITION_SOURCE_URL.replace("{id}", encodeURIComponent(release.id));
    return release.sourceUrl;
  }
  if (/^https:\/\/(?:music\.apple\.com|listen\.tidal\.com|tidal\.com)\//i.test(release.sourceUrl || "")) {
    return release.sourceUrl;
  }
  const mbid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(release.id || "")
    ? release.id
    : null;
  let group;
  if (mbid) {
    group = await musicBrainz(`/release-group/${mbid}?inc=artist-credits+url-rels&fmt=json`);
  } else {
    const query = `releasegroup:${release.title} AND artist:${release.artist}`;
    const result = await musicBrainz(`/release-group?query=${encodeURIComponent(query)}&fmt=json&limit=10`);
    group = (result["release-groups"] || []).find((item) =>
      normalized(item.title) === normalized(release.title)
      && (item["artist-credit"] || []).some((credit) => normalized(credit.artist?.name) === normalized(release.artist))
    );
  }
  if (!group || normalized(group.title) !== normalized(release.title)) {
    throw new Error("MusicBrainz could not identify the exact album release.");
  }
  const groupArtist = (group["artist-credit"] || []).map((credit) => credit.artist?.name).filter(Boolean).join(", ");
  const requestedArtist = normalized(release.artist);
  const matchedArtist = normalized(groupArtist);
  if (groupArtist && matchedArtist !== requestedArtist
    && !matchedArtist.includes(requestedArtist)
    && !requestedArtist.includes(matchedArtist)) {
    throw new Error("MusicBrainz artist did not match the requested album.");
  }
  const linkedSource = (group.relations || [])
    .map((relation) => relation.url?.resource)
    .find((url) => /^https:\/\/(?:music\.apple\.com|listen\.tidal\.com|tidal\.com)\//i.test(url || ""));
  if (linkedSource) {
    release.musicBrainzId = group.id;
    release.sourceUrl = linkedSource;
    return linkedSource;
  }
  const year = group["first-release-date"]?.slice(0, 4) || release.year || "";
  const candidates = [];
  for (const country of ["NZ", "US", "GB"]) {
    const url = `https://itunes.apple.com/search?${new URLSearchParams({
      term: `${release.artist} ${release.title}`,
      entity: "album",
      country,
      limit: "50"
    })}`;
    const search = await fetchWithRetry(url, { signal: AbortSignal.timeout(10_000) }, "Apple catalogue");
    candidates.push(...((await search.json()).results || []));
    if (candidates.some((item) =>
      normalized(item.collectionName) === normalized(group.title)
      && normalized(item.artistName) === normalized(release.artist))) break;
  }
  const exact = candidates.find((item) =>
    normalized(item.collectionName) === normalized(group.title)
    && normalized(item.artistName) === normalized(release.artist)
    && (!year || String(item.releaseDate || "").startsWith(year))
  ) || candidates.find((item) =>
    normalized(item.collectionName) === normalized(group.title)
    && normalized(item.artistName) === normalized(release.artist)
  );
  if (!exact?.collectionViewUrl) throw new Error("MusicBrainz release was not available in a supported download catalogue.");
  release.musicBrainzId = group.id;
  release.sourceUrl = exact.collectionViewUrl;
  return exact.collectionViewUrl;
}

async function resolveMissingTrackSource(release, missingTrack) {
  if (testMode) return resolveMusicBrainzAlbumSource(release);
  const [discNumber, trackNumber] = String(missingTrack).split(":").map(Number);
  if (!discNumber || !trackNumber) throw new Error(`Invalid missing track reference: ${missingTrack}`);
  const candidates = [];
  for (const country of ["NZ", "US", "GB"]) {
    const searchUrl = `https://itunes.apple.com/search?${new URLSearchParams({
      term: `${release.artist} ${release.title}`,
      entity: "album",
      country,
      limit: "50"
    })}`;
    const search = await fetchWithRetry(searchUrl, { signal: AbortSignal.timeout(10_000) }, "Apple catalogue");
    candidates.push(...((await search.json()).results || []));
    if (candidates.some((item) => normalized(item.collectionName) === normalized(release.title)
      && normalized(item.artistName) === normalized(release.artist))) break;
  }
  const album = candidates.find((item) => normalized(item.collectionName) === normalized(release.title)
    && normalized(item.artistName) === normalized(release.artist));
  if (!album?.collectionId) throw new Error("Could not map the incomplete album to an exact catalogue release.");
  const searchCountry = candidates.find((item) => item.collectionId === album.collectionId)?.country;
  const country = /^[A-Z]{2}$/.test(searchCountry || "") ? searchCountry : "NZ";
  const lookupUrl = `https://itunes.apple.com/lookup?${new URLSearchParams({
    id: String(album.collectionId), entity: "song", country
  })}`;
  const lookup = await fetchWithRetry(lookupUrl, { signal: AbortSignal.timeout(10_000) }, "Apple track catalogue");
  const track = ((await lookup.json()).results || []).find((item) => item.wrapperType === "track"
    && Number(item.discNumber || 1) === discNumber
    && Number(item.trackNumber) === trackNumber);
  if (!track?.trackViewUrl) throw new Error(`Could not resolve missing track ${missingTrack} in the matched release.`);
  return track.trackViewUrl;
}

function acquisitionStage(id) {
  return join(stagingRoot, createHash("sha256").update(id).digest("hex"));
}

const acquisitionStageMarker = (stage) => join(stage, ".signal-acquisition.json");

async function prepareAcquisitionStage(state, stage) {
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await writeFile(acquisitionStageMarker(stage), `${JSON.stringify({
    schemaVersion: 1,
    acquisitionId: state.id,
    artist: state.artist,
    title: state.title,
    attempt: state.attempt,
    createdAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
}

async function assertAcquisitionStageOwner(state, stage) {
  let marker;
  try {
    marker = JSON.parse(await readFile(acquisitionStageMarker(stage), "utf8"));
  } catch (error) {
    throw new Error(`Staging ownership could not be verified: ${error.message}`);
  }
  if (marker.acquisitionId !== state.id) {
    throw new Error("Staging ownership did not match the active acquisition.");
  }
}

async function stagingInventory() {
  return readStagingInventory({ stagingRoot, acquisitions: acquisitionState });
}

async function validateAndImportStaged(state, stage) {
  await assertAcquisitionStageOwner(state, stage);
  const paths = await walk(stage).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  if (!paths.length) throw new Error("Downloader exited without adding any album files to staging.");
  const stagedTracks = [];
  for (const path of paths) stagedTracks.push({ path, track: await probe(path) });
  const matching = stagedTracks.filter(({ track }) => normalized(track.albumArtist) === normalized(state.artist)
    && normalized(canonicalAlbumTitle(track.album)) === normalized(canonicalAlbumTitle(state.title)));
  if (!matching.length) throw new Error("Staged files did not match the requested artist and album.");
  if (state.missingTracks?.length) {
    const [disc, track] = state.missingTracks[0].split(":").map(Number);
    const expected = shadowAlbums.get(shadowAlbumId(state.artist, state.title))?.manifest
      ?.find((item) => item.disc === disc && item.position === track);
    if (!matching.some((item) => item.track.disc === disc && item.track.track === track
      && (!expected || normalized(canonicalTrackTitle(item.track.title)) === normalized(canonicalTrackTitle(expected.title))))) {
      throw new Error(`Staged download did not contain the requested missing track ${state.missingTracks[0]}.`);
    }
  } else {
    const trackNumbers = new Set(matching.map((item) => `${item.track.disc}:${item.track.track}`).filter((value) => !value.endsWith(":0")));
    const declaredTotal = Math.max(0, ...matching.map((item) => item.track.trackTotal || 0));
    if (declaredTotal > 0 && trackNumbers.size < declaredTotal) {
      throw new Error(`Staged album is incomplete (${trackNumbers.size}/${declaredTotal} tracks).`);
    }
  }
  state.message = "Validated; importing into the library…";
  void saveAcquisitions();
  if (!state.missingTracks?.length) {
    if (matching.length !== stagedTracks.length) {
      throw new Error("Staged album contained audio outside the requested release.");
    }
    const albumDirectories = new Set(matching.map(({ path }) => dirname(path)));
    if (albumDirectories.size !== 1) {
      throw new Error("Staged album was split across multiple directories.");
    }
    const source = [...albumDirectories][0];
    const destination = resolve(downloadRoot, relative(stage, source));
    if (!destination.startsWith(`${downloadRoot}${sep}`)) throw new Error("Unsafe staged album path.");
    await publishAlbumDirectory({ source, destination, stage });
    return matching.length;
  }
  for (const { path } of matching) {
    const destination = resolve(downloadRoot, relative(stage, path));
    if (!destination.startsWith(`${downloadRoot}${sep}`)) throw new Error("Unsafe staged download path.");
    await mkdir(join(destination, ".."), { recursive: true });
    if (existsSync(destination)) continue;
    await rename(path, destination);
  }
  await rm(stage, { recursive: true, force: true });
  return matching.length;
}

async function runAcquisition(state, release) {
  state.status = "resolving";
  state.message = "Matching the exact MusicBrainz release…";
  state.startedAt = new Date().toISOString();
  void saveAcquisitions();
  const shadow = shadowAlbums.get(shadowAlbumId(state.artist, state.title));
  if (shadow) {
    shadow.status = "identifying";
    shadow.lastError = null;
    void saveShadowAlbums();
  }
  let sourceUrl;
  try {
    sourceUrl = state.missingTracks?.length
      ? await resolveMissingTrackSource(release, state.missingTracks[0])
      : await resolveMusicBrainzAlbumSource(release);
  } catch (error) {
    const rateLimited = error.status === 429 || lookupRateLimitState().active;
    const transient = rateLimited || /timeout|aborted|fetch failed|temporarily|HTTP 5\d\d/i.test(error.message || "");
    state.lookupAttempt = (state.lookupAttempt || 0) + 1;
    const retryLookup = transient && state.lookupAttempt < acquisitionMaxAttempts;
    state.status = state.cancelRequested ? "cancelled" : retryLookup ? "queued" : "failed";
    state.message = state.cancelRequested
      ? "Cancelled by user."
      : retryLookup
        ? `Catalogue lookup failed temporarily. Retrying (${state.lookupAttempt + 1}/${acquisitionMaxAttempts}).`
        : error.message;
    state.finishedAt = retryLookup ? null : new Date().toISOString();
    if (retryLookup && !acquisitionQueue.includes(state.id)) acquisitionQueue.push(state.id);
    delete state.cancelRequested;
    finishAcquisition(state);
    return;
  }
  delete state.lookupAttempt;
  if (state.cancelRequested) {
    state.status = "cancelled";
    state.message = "Cancelled by user.";
    state.automaticRepairSuppressed = true;
    state.finishedAt = new Date().toISOString();
    delete state.cancelRequested;
    finishAcquisition(state);
    return;
  }
  state.status = "running";
  state.message = "Preparing isolated staging area…";
  state.attempt = (state.attempt || 0) + 1;
  if (shadow) shadow.status = "acquiring";
  void saveShadowAlbums();
  const stage = acquisitionStage(state.id);
  await prepareAcquisitionStage(state, stage);
  void saveAcquisitions();
  const child = spawn(
    spotiflacBin,
    [sourceUrl, stage,
      "--service", "qobuz", "amazon", "tidal", "deezer",
      "--quality", "HI_RES_LOSSLESS",
      "--filename-format", "[{year}] {album}/{title}",
      "--use-track-numbers", "--use-artist-subfolders", "--use-album-subfolders",
      "--retries", "2", "--timeout", "120"],
    {
      cwd: spotiflacCwd,
      detached: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  activeAcquisitionProcess = child;
  let tail = "";
  let lastProgressAt = Date.now();
  const capture = (chunk) => {
    const previous = `${state.trackNumber}|${state.progress}|${state.currentTrack}|${state.provider}`;
    const clean = String(chunk)
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\r/g, "\n");
    tail = `${tail}${clean}`.slice(-10000);
    const trackMatches = [...tail.matchAll(/Track \[(\d+)\/(\d+)\] ([^\n—]+(?:—[^\n]+)?)/g)];
    const track = trackMatches.at(-1);
    if (track) {
      state.trackNumber = Number(track[1]);
      state.totalTracks = Number(track[2]);
      state.currentTrack = track[3].trim();
      state.progress = Math.max(state.progress, Math.round((state.trackNumber - 1) / state.totalTracks * 100));
      state.message = `Track ${state.trackNumber} of ${state.totalTracks}`;
    } else {
      state.message = "Connecting to download providers…";
    }
    const sourceMatches = [...tail.matchAll(/\[SOURCE\]\s+([^\n]+)/g)];
    if (sourceMatches.length) state.provider = sourceMatches.at(-1)[1].trim();
    const sessionProgress = [...tail.matchAll(/Progress:\s+(\d+)%/g)].at(-1);
    if (sessionProgress) state.progress = Math.max(state.progress, Number(sessionProgress[1]));
    const current = `${state.trackNumber}|${state.progress}|${state.currentTrack}|${state.provider}`;
    if (current !== previous) lastProgressAt = Date.now();
  };
  const inactivityTimer = setInterval(() => {
    if (Date.now() - lastProgressAt < acquisitionStallTimeoutMs) return;
    state.timeoutRequested = true;
    state.message = "Provider stalled; stopping this attempt.";
    void saveAcquisitions();
    terminateProcessTree(child);
  }, Math.min(15_000, Math.max(100, Math.floor(acquisitionStallTimeoutMs / 4))));
  inactivityTimer.unref();
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("error", (error) => {
    clearInterval(inactivityTimer);
    state.status = "failed";
    state.message = error.message;
    state.finishedAt = new Date().toISOString();
    finishAcquisition(state);
  });
  child.on("close", async (code) => {
    clearInterval(inactivityTimer);
    if (state.finishedAt) return;
    activeAcquisitionProcess = null;
    if (state.timeoutRequested) {
      delete state.timeoutRequested;
      if (state.attempt < acquisitionMaxAttempts) {
        state.status = "queued";
        const retryDelayMs = testMode ? 50 : 60_000 * (2 ** (state.attempt - 1));
        state.retryAt = new Date(Date.now() + retryDelayMs).toISOString();
        state.message = `Provider stalled. Retry ${state.attempt + 1}/${acquisitionMaxAttempts} scheduled.`;
        state.progress = 0;
        state.trackNumber = 0;
        state.currentTrack = "";
        acquisitionQueue.push(state.id);
      } else {
        state.status = "failed";
        state.message = `Provider stalled on ${acquisitionMaxAttempts} attempts.`;
        state.finishedAt = new Date().toISOString();
      }
      finishAcquisition(state);
      return;
    }
    if (state.cancelRequested) {
      state.status = "cancelled";
      state.message = "Cancelled by user.";
      state.finishedAt = new Date().toISOString();
      delete state.cancelRequested;
      finishAcquisition(state);
      return;
    }
    let reportedSuccess = code === 0 || code === 10;
    let importError = null;
    if (reportedSuccess) {
      try {
        await validateAndImportStaged(state, stage);
        await scanLibrary();
        if (!testMode) {
          await identifyShadowAlbum(shadowAlbumId(state.artist, state.title));
          await refreshPublishedLibrary();
        }
      } catch (error) {
        reportedSuccess = false;
        importError = error;
      }
    }
    const libraryAlbum = cataloguedLibrary.albums.find((album) =>
      normalized(album.artist) === normalized(state.artist)
      && normalized(album.title) === normalized(state.title)
    );
    const shadowRecord = shadowAlbums.get(shadowAlbumId(state.artist, state.title));
    const remainingMissing = shadowRecord?.authoritative
      ? shadowRecord.manifest.filter((track) => track.status === "missing").map((track) => `${track.disc}:${track.position}`)
      : libraryAlbum?.missingTracks || [];
    const shadowPublished = testMode || shadowRecord?.published;
    const continueTrackRepair = reportedSuccess && state.missingTracks?.length && remainingMissing.length > 0;
    state.status = reportedSuccess && libraryAlbum && !libraryAlbum.incomplete && shadowPublished
      ? "complete"
      : continueTrackRepair ? "queued" : "failed";
    if (state.status === "complete") {
      state.progress = 100;
      delete state.attempt;
      managedAlbums.add(albumKey(state.artist, state.title));
      void saveRepairPolicy();
    }
    state.message = state.status === "complete"
      ? "Added to your library."
      : state.status === "queued"
        ? `${remainingMissing.length} missing track${remainingMissing.length === 1 ? "" : "s"} remaining; continuing track repair.`
      : (importError?.message || tail.match(/(?:Failed|ERROR|Error):?[^\n]*/g)?.at(-1)
        || (reportedSuccess && libraryAlbum?.incomplete
          ? `Downloader finished with ${libraryAlbum.missingTracks.length} missing track${libraryAlbum.missingTracks.length === 1 ? "" : "s"}.`
          : reportedSuccess && libraryAlbum && !shadowPublished
            ? "Album downloaded but did not pass authoritative release validation."
            : reportedSuccess ? "Downloader exited without adding any album files." : `Download exited with code ${code}.`));
    if (state.status === "queued") {
      state.missingTracks = remainingMissing;
      state.progress = 0;
      state.trackNumber = 0;
      state.currentTrack = "";
      state.finishedAt = null;
      acquisitionQueue.push(state.id);
    } else {
      state.finishedAt = new Date().toISOString();
    }
    finishAcquisition(state);
  });
}

function cancelAcquisition(id) {
  const state = acquisitionState.get(id);
  if (!state || !["queued", "resolving", "running"].includes(state.status)) return null;
  if (state.status === "queued") {
    const index = acquisitionQueue.indexOf(id);
    if (index !== -1) acquisitionQueue.splice(index, 1);
    state.status = "cancelled";
    state.message = "Cancelled by user.";
    state.automaticRepairSuppressed = true;
    state.finishedAt = new Date().toISOString();
    finishAcquisition(state);
    return state;
  }
  state.cancelRequested = true;
  state.automaticRepairSuppressed = true;
  state.message = "Cancelling…";
  void saveAcquisitions();
  terminateProcessTree(activeAcquisitionProcess);
  return state;
}

function prioritizeAcquisition(id) {
  const state = acquisitionState.get(id);
  if (!state || state.status !== "queued") return null;
  const index = acquisitionQueue.indexOf(id);
  if (index < 0) return null;
  acquisitionQueue.splice(index, 1);
  acquisitionQueue.unshift(id);
  state.message = "Prioritised for download.";
  refreshQueuePositions();
  void saveAcquisitions();
  return state;
}

function processAcquisitionQueue() {
  if (!initialLibraryScanComplete || activeAcquisitionId || acquisitionQueue.length === 0) return;
  if (lookupRateLimitState().active) {
    scheduleLookupRetry();
    return;
  }
  refreshQueuePositions();
  const readyIndex = acquisitionQueue.findIndex((candidateId) => {
    const retryAt = new Date(acquisitionState.get(candidateId)?.retryAt || 0).getTime();
    return !retryAt || retryAt <= Date.now();
  });
  if (readyIndex < 0) {
    const nextRetry = Math.min(...acquisitionQueue
      .map((candidateId) => new Date(acquisitionState.get(candidateId)?.retryAt || 0).getTime())
      .filter(Boolean));
    if (acquisitionRetryTimer) clearTimeout(acquisitionRetryTimer);
    acquisitionRetryTimer = setTimeout(() => {
      acquisitionRetryTimer = null;
      processAcquisitionQueue();
    }, Math.max(50, nextRetry - Date.now() + 20));
    acquisitionRetryTimer.unref();
    return;
  }
  const [id] = acquisitionQueue.splice(readyIndex, 1);
  const state = acquisitionState.get(id);
  const release = catalogueReleases.get(id);
  if (!state || !release) {
    activeAcquisitionId = null;
    refreshQueuePositions();
    return processAcquisitionQueue();
  }
  if (albumIsCompleteInLibrary(state)) {
    state.status = "complete";
    state.progress = 100;
    state.message = "Already complete in your library.";
    state.finishedAt = new Date().toISOString();
    refreshQueuePositions();
    void saveAcquisitions();
    return processAcquisitionQueue();
  }
  activeAcquisitionId = id;
  delete state.retryAt;
  refreshQueuePositions();
  void runAcquisition(state, release);
}

function queueAlbum(id, release, origin = "manual") {
  catalogueReleases.set(id, release);
  const current = acquisitionState.get(id);
  if (current && ["queued", "resolving", "running", "complete"].includes(current.status)) return current;
  const equivalent = [...acquisitionState.values()].find((item) =>
    ["queued", "resolving", "running"].includes(item.status)
    && albumKey(item.artist, item.title) === albumKey(release.artist, release.title));
  if (equivalent) return equivalent;
  const state = {
    id,
    artist: release.artist,
    title: release.title,
    origin,
    priority: acquisitionPriorities[origin] || acquisitionPriorities.manual,
    status: "queued",
    message: "Queued for download.",
    currentTrack: "",
    trackNumber: 0,
    totalTracks: 0,
    progress: 0,
    provider: "",
    queuePosition: 0,
    queuedAt: new Date().toISOString()
  };
  acquisitionState.set(id, state);
  const shadowId = shadowAlbumId(release.artist, release.title);
  const existingShadow = shadowAlbums.get(shadowId) || {};
  shadowAlbums.set(shadowId, {
    ...existingShadow,
    schemaVersion: 1,
    id: shadowId,
    artist: release.artist,
    title: canonicalAlbumTitle(release.title),
    originalReleaseYear: release.year || existingShadow.originalReleaseYear || null,
    source: origin,
    status: "queued",
    published: false,
    acquisitionId: id,
    manifest: existingShadow.manifest || [],
    firstSeenAt: existingShadow.firstSeenAt || state.queuedAt,
    lastScannedAt: existingShadow.lastScannedAt || null,
    lastError: null
  });
  void saveShadowAlbums();
  acquisitionQueue.push(id);
  refreshQueuePositions();
  void saveAcquisitions();
  processAcquisitionQueue();
  return state;
}

function acquireAlbum(id, response, origin = "manual") {
  const release = catalogueReleases.get(id);
  if (!release) {
    return sendJson(response, 404, {
      error: "Search for this album again before downloading it."
    });
  }
  for (const state of acquisitionState.values()) {
    if (state.status === "cancelled"
      && normalized(state.artist) === normalized(release.artist)
      && normalized(state.title) === normalized(release.title)) {
      state.automaticRepairSuppressed = false;
    }
  }
  return sendJson(response, 202, queueAlbum(id, release, origin));
}

async function repairIncompleteAlbums({ rescan = true } = {}) {
  if (rescan) await scanLibrary();
  const incompleteAlbums = new Map(cataloguedLibrary.albums.filter((album) => album.incomplete)
    .map((album) => [albumKey(album.artist, album.title), album]));
  // Approvals are a view of current album state, not permanent history.
  // Drop edition aliases and albums that are no longer incomplete, and let
  // the candidate pass below create one canonical approval where required.
  for (const [id, approval] of repairApprovals) {
    if (approval.status !== "pending") continue;
    const album = incompleteAlbums.get(albumKey(approval.artist, approval.title));
    const canonicalId = album ? `approval:${album.id}` : null;
    if (!album || id !== canonicalId) repairApprovals.delete(id);
    else {
      approval.artist = album.artist;
      approval.title = album.title;
      approval.year = album.year;
      approval.missingTracks = [...album.missingTracks];
      approval.missingDiscs = album.missingDiscs;
    }
  }
  const cancelledAlbums = new Set([...acquisitionState.values()]
    .filter((state) => state.status === "cancelled" && state.automaticRepairSuppressed !== false)
    .map((state) => albumKey(state.artist, state.title)));
  const busyAlbums = new Set([...acquisitionState.values()]
    .filter((state) => ["queued", "resolving", "running"].includes(state.status))
    .map((state) => albumKey(state.artist, state.title)));
  const candidates = cataloguedLibrary.albums.filter((album) =>
    album.incomplete
    && !cancelledAlbums.has(albumKey(album.artist, album.title))
    && !busyAlbums.has(albumKey(album.artist, album.title))
  );
  const results = [];
  for (const album of candidates) {
    const key = albumKey(album.artist, album.title);
    if (!managedAlbums.has(key)) {
      const id = `approval:${album.id}`;
      const existing = repairApprovals.get(id);
      if (!existing) {
        repairApprovals.set(id, {
          id, artist: album.artist, title: album.title, year: album.year,
          missingTracks: [...album.missingTracks], missingDiscs: album.missingDiscs,
          status: "pending", reason: "Format cannot prove this imported album is missing audio.",
          createdAt: existing?.createdAt || new Date().toISOString()
        });
      }
      results.push({ id, artist: album.artist, title: album.title, status: "approval_required" });
      continue;
    }
    const id = `repair:${album.id}`;
    const state = queueAlbum(id, {
      id,
      artist: album.artist,
      title: album.title,
      year: album.year,
      sourceUrl: album.sourceUrl
    }, "automatic_repair");
    state.missingTracks = [...album.missingTracks];
    state.missingDiscs = album.missingDiscs;
    state.repairMode = "track";
    void saveAcquisitions();
    results.push({
      id,
      artist: album.artist,
      title: album.title,
      missingTracks: album.missingTracks,
      missingDiscs: album.missingDiscs,
      status: state.status
    });
  }
  await saveRepairPolicy();
  void analysePendingRepairs().catch((error) => console.error("Repair approval analysis failed:", error.message));
  return results;
}

async function approveRepair(id) {
  const approval = repairApprovals.get(id);
  if (!approval || approval.status !== "pending") return null;
  approval.status = "approved";
  approval.reviewedAt = new Date().toISOString();
  const repairId = `repair:${encodeURIComponent(`${approval.artist}\0${approval.title}`)}`;
  const state = queueAlbum(repairId, {
    id: repairId, artist: approval.artist, title: approval.title, year: approval.year
  }, "approved_repair");
  state.missingTracks = [...approval.missingTracks];
  state.missingDiscs = approval.missingDiscs;
  state.repairMode = "track";
  approval.acquisitionId = repairId;
  await saveRepairPolicy();
  void saveAcquisitions();
  return { approval, acquisition: state };
}

async function dismissRepair(id) {
  const approval = repairApprovals.get(id);
  if (!approval || approval.status !== "pending") return null;
  approval.status = "dismissed";
  approval.reviewedAt = new Date().toISOString();
  await saveRepairPolicy();
  return approval;
}

async function reviewRepair(id) {
  const approval = repairApprovals.get(id);
  if (!approval || approval.status !== "pending") return null;
  const album = cataloguedLibrary.albums.find((item) => normalized(item.artist) === normalized(approval.artist)
    && normalized(canonicalAlbumTitle(item.title)) === normalized(canonicalAlbumTitle(approval.title)));
  if (!album) throw new Error("The local album is no longer present in the library.");
  const localTracks = album.trackIds.map(getLibraryTrack).filter(Boolean);
  const query = `releasegroup:${canonicalAlbumTitle(album.title)} AND artist:${album.artist}`;
  const search = await musicBrainz(`/release-group?query=${encodeURIComponent(query)}&fmt=json&limit=10`);
  const group = (search["release-groups"] || []).find((item) =>
    normalized(canonicalAlbumTitle(item.title)) === normalized(canonicalAlbumTitle(album.title))
    && (item["artist-credit"] || []).some((credit) => normalized(credit.artist?.name) === normalized(album.artist)))
    || (search["release-groups"] || [])[0];
  if (!group) throw new Error("MusicBrainz could not identify this album.");
  const releasesResponse = await musicBrainz(`/release?release-group=${group.id}&inc=recordings+media+artist-credits&fmt=json&limit=100`);
  const releases = releasesResponse.releases || [];
  const localTitles = new Set(localTracks.map((track) => normalized(track.title)));
  const releaseScore = (release) => {
    const reference = (release.media || []).flatMap((medium) => medium.tracks || []);
    const overlap = reference.filter((track) => localTitles.has(normalized(track.recording?.title || track.title))).length;
    const yearMatch = album.year && String(release.date || "").startsWith(album.year) ? 3 : 0;
    const expectedCount = album.expectedTracks || localTracks.length;
    return overlap * 5 + yearMatch - Math.abs(reference.length - expectedCount) * 20 - Math.max(0, (release.media || []).length - 1) * 25;
  };
  const release = [...releases].sort((left, right) => releaseScore(right) - releaseScore(left))[0];
  if (!release) throw new Error("MusicBrainz has no track listing for this album.");
  const referenceTracks = (release.media || []).flatMap((medium, mediumIndex) =>
    (medium.tracks || []).map((track, trackIndex) => ({
      disc: Number(medium.position) || mediumIndex + 1,
      track: Number(track.position) || trackIndex + 1,
      title: track.recording?.title || track.title || `Track ${trackIndex + 1}`,
      duration: Math.round(Number(track.length || track.recording?.length || 0) / 1000)
    })));
  const usedLocalIds = new Set();
  const comparison = referenceTracks.map((reference) => {
    const numbered = localTracks.find((track) => !usedLocalIds.has(track.id)
      && track.disc === reference.disc && track.track === reference.track);
    const titled = localTracks.find((track) => !usedLocalIds.has(track.id)
      && normalized(track.title) === normalized(reference.title));
    const local = titled || numbered || null;
    if (local) usedLocalIds.add(local.id);
    const titleMatches = local && normalized(local.title) === normalized(reference.title);
    // Duration belongs to the local file. It is useful information for the
    // review, but never evidence that the album has the wrong track.
    return {
      reference, local,
      status: !local ? "missing" : titleMatches ? "match" : "mismatch",
      mismatchKind: !titleMatches ? "title" : null,
      decision: approval.trackDecisions?.[`${reference.disc}:${reference.track}`] || null
    };
  });
  const extras = localTracks.filter((track) => !usedLocalIds.has(track.id));
  return {
    album: { id: album.id, artist: album.artist, title: album.title, year: album.year },
    release: { id: release.id, title: release.title, date: release.date, country: release.country,
      label: (release["label-info"] || [])[0]?.label?.name || "", url: `https://musicbrainz.org/release/${release.id}` },
    comparison,
    extras
  };
}

async function applyRepairTrackDecision(id, disc, trackNumber, choice) {
  const approval = repairApprovals.get(id);
  if (!approval || approval.status !== "pending") return null;
  const review = await reviewRepair(id);
  const item = review.comparison.find((entry) => entry.reference.disc === disc && entry.reference.track === trackNumber);
  if (!item) throw Object.assign(new Error("Track is not present in the selected MusicBrainz release."), { status: 404 });
  approval.trackDecisions ||= {};
  const decisionKey = `${disc}:${trackNumber}`;

  if (choice === "download") {
    if (item.status !== "missing") throw Object.assign(new Error("Only a missing track can be downloaded from this action."), { status: 409 });
    const state = queueApprovedMissingTrack(approval, decisionKey);
    await saveRepairPolicy();
    void saveAcquisitions();
    return { approval, acquisition: state };
  }

  if (choice === "keep-local") {
    if (!item.local) throw Object.assign(new Error("There is no local track to keep."), { status: 409 });
    approval.trackDecisions[decisionKey] = { choice, decidedAt: new Date().toISOString() };
    await saveRepairPolicy();
    return { approval, track: item.local };
  }

  if (choice === "use-musicbrainz") {
    if (!item.local || item.status !== "mismatch" || item.mismatchKind !== "title") {
      throw Object.assign(new Error("This action only applies to a local title mismatch."), { status: 409 });
    }
    await rewriteTrackTitle(item.local, item.reference.title);
    approval.trackDecisions[decisionKey] = {
      choice, previousTitle: item.local.title, title: item.reference.title, decidedAt: new Date().toISOString()
    };
    await saveRepairPolicy();
    void scanLibrary().catch((error) => console.error("Library rescan after title correction failed:", error.message));
    return { approval, title: item.reference.title };
  }

  throw Object.assign(new Error("Unknown track decision."), { status: 400 });
}

async function rewriteTrackTitle(track, title) {
  const source = safeMusicPath(track.id);
  if (!source || !existsSync(source)) throw Object.assign(new Error("The local audio file no longer exists."), { status: 404 });
  const temporary = `${source}.signal-title-${process.pid}${extname(source)}`;
  await execFileAsync("ffmpeg", ["-loglevel", "error", "-i", source, "-map", "0", "-c", "copy", "-map_metadata", "0",
    "-metadata", `title=${title}`, "-y", temporary]);
  await moveToSignalTrash(source);
  await rename(temporary, source);
}

async function editAlbumMetadata(albumId, input) {
  const album = library.albums.find((item) => item.id === albumId);
  if (!album) throw Object.assign(new Error("Album not found in the published library."), { status: 404 });
  const clean = (value, fallback = "") => String(value ?? fallback).trim().slice(0, 500);
  const albumArtist = clean(input.albumArtist, album.artist);
  const albumTitle = clean(input.albumTitle, album.title);
  const originalYear = clean(input.originalYear, album.year);
  const genre = clean(input.genre, album.genre);
  if (!albumArtist || !albumTitle) throw Object.assign(new Error("Album artist and title are required."), { status: 400 });
  if (originalYear && !/^\d{4}(?:-\d{2}-\d{2})?$/.test(originalYear)) {
    throw Object.assign(new Error("Original year must be YYYY or YYYY-MM-DD."), { status: 400 });
  }
  const requestedTitles = new Map((Array.isArray(input.tracks) ? input.tracks : [])
    .map((track) => [String(track.id || ""), clean(track.title)]));
  const tracks = album.trackIds.map((id) => library.tracks.find((track) => track.id === id)).filter(Boolean);
  if (!tracks.length) throw Object.assign(new Error("Album has no editable tracks."), { status: 409 });
  for (const track of tracks) {
    const source = safeMusicPath(track.id);
    if (!source || !existsSync(source)) throw Object.assign(new Error(`Track file is missing: ${track.title}`), { status: 404 });
    const title = requestedTitles.get(track.id) || track.title;
    const temporary = `${source}.signal-metadata-${process.pid}${extname(source)}`;
    const metadata = [
      ["album_artist", albumArtist], ["album", albumTitle], ["title", title],
      ["date", originalYear], ["originaldate", originalYear], ["genre", genre]
    ];
    await execFileAsync("ffmpeg", ["-loglevel", "error", "-i", source, "-map", "0", "-c", "copy", "-map_metadata", "0",
      ...metadata.flatMap(([name, value]) => ["-metadata", `${name}=${value}`]), "-y", temporary]);
    await moveToSignalTrash(source);
    await rename(temporary, source);
  }
  const oldShadowEntry = [...shadowAlbums.entries()].find(([, record]) => record.localAlbumId === album.id);
  if (oldShadowEntry) {
    const [oldId, record] = oldShadowEntry;
    const newId = shadowAlbumId(albumArtist, albumTitle);
    shadowAlbums.delete(oldId);
    shadowAlbums.set(newId, { ...record, id: newId, artist: albumArtist, title: canonicalAlbumTitle(albumTitle), source: record.source || "existing-library" });
    await saveShadowAlbums();
  }
  if (/^\d{4}/.test(originalYear)) {
    firstReleaseYears.set(albumKey(albumArtist, albumTitle), originalYear.slice(0, 4));
    await saveFirstReleaseYears();
  }
  await scanLibrary();
  const updated = library.albums.find((item) => normalized(item.artist) === normalized(albumArtist)
    && normalized(item.title) === normalized(canonicalAlbumTitle(albumTitle)));
  return { album: updated || null, library };
}

function queueApprovedMissingTrack(approval, decisionKey, automatic = false) {
  const repairId = `repair-track:${encodeURIComponent(`${approval.artist}\0${canonicalAlbumTitle(approval.title)}\0${decisionKey}`)}`;
  const state = queueAlbum(repairId, {
    id: repairId, artist: approval.artist, title: canonicalAlbumTitle(approval.title), year: approval.year
  }, automatic ? "automatic_repair" : "approved_repair");
  state.missingTracks = [decisionKey];
  state.missingDiscs = 0;
  state.repairMode = "track";
  approval.trackDecisions ||= {};
  approval.trackDecisions[decisionKey] = {
    choice: "download", automatic, acquisitionId: repairId, decidedAt: new Date().toISOString()
  };
  return state;
}

async function analysePendingRepairs() {
  if (approvalAnalysisPromise) return approvalAnalysisPromise;
  approvalAnalysisPromise = (async () => {
    for (const approval of repairApprovals.values()) {
      if (approval.status !== "pending" || approval.analysisInProgress) continue;
      approval.analysisInProgress = true;
      try {
        const review = await reviewRepair(approval.id);
        const missing = review.comparison.filter((item) => item.status === "missing");
        const titleMismatches = review.comparison.filter((item) => item.status === "mismatch" && item.local);
        approval.lastAnalysedAt = new Date().toISOString();
        for (const item of titleMismatches) {
          await rewriteTrackTitle(item.local, item.reference.title);
          const key = `${item.reference.disc}:${item.reference.track}`;
          approval.trackDecisions ||= {};
          approval.trackDecisions[key] = {
            choice: "use-musicbrainz", automatic: true, previousTitle: item.local.title,
            title: item.reference.title, decidedAt: new Date().toISOString()
          };
        }
        for (const item of missing) {
          const key = `${item.reference.disc}:${item.reference.track}`;
          if (!approval.trackDecisions?.[key]) queueApprovedMissingTrack(approval, key, true);
        }
        approval.reason = missing.length
          ? "Missing MusicBrainz album tracks were queued automatically."
          : "Album metadata was reconciled automatically.";
        approval.status = missing.length ? "automated" : "resolved";
        approval.reviewedAt = new Date().toISOString();
        if (titleMismatches.length) void scanLibrary().catch((error) => console.error("Library rescan after automatic title correction failed:", error.message));
      } catch (error) {
        approval.reason = `Album match needs review: ${error.message}`;
      } finally {
        delete approval.analysisInProgress;
        await saveRepairPolicy();
        void saveAcquisitions();
      }
    }
  })().finally(() => { approvalAnalysisPromise = null; });
  return approvalAnalysisPromise;
}

function getLibraryTrack(id) {
  return cataloguedLibrary.tracks.find((track) => track.id === id) || library.tracks.find((track) => track.id === id);
}

async function loadDiscoveries() {
  try {
    discoveries = JSON.parse(await readFile(discoveryFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load discovery queue:", error.message);
    discoveries = [];
  }
  for (const item of discoveries) {
    catalogueReleases.set(item.id, {
      id: item.id,
      artist: item.artist,
      title: item.title,
      year: item.year
    });
  }
}

async function saveDiscoveries() {
  await mkdir(dataDir, { recursive: true });
  const temporary = `${discoveryFile}.tmp`;
  await writeFile(temporary, `${JSON.stringify(discoveries, null, 2)}\n`, "utf8");
  await rename(temporary, discoveryFile);
}

async function generateDiscovery({ force = false } = {}) {
  if (!library.albums.length) throw new Error("The local library is empty.");
  const localDay = (value = new Date()) => new Date(value).toLocaleDateString("en-CA", { timeZone: "Pacific/Auckland" });
  const existingToday = discoveries.find((item) => localDay(item.createdAt) === localDay());
  if (existingToday && !force) return existingToday;
  const seed = library.albums[Math.floor(Math.random() * library.albums.length)];
  const connectedArtists = await fetchRecommendations([seed.artist]);
  if (!connectedArtists.length) throw new Error(`No connected artists were found for ${seed.artist}.`);
  const shuffledArtists = [...connectedArtists].sort(() => Math.random() - 0.5);
  const existing = new Set(discoveries.map((item) => item.id));
  for (const connected of shuffledArtists) {
    const catalogue = await searchCatalogue(connected.artist);
    const candidates = catalogue.albums.filter((album) => !album.owned && !existing.has(album.id));
    if (!candidates.length) continue;
    const album = candidates[Math.floor(Math.random() * candidates.length)];
    const item = {
      id: album.id,
      seedAlbum: seed.title,
      seedArtist: seed.artist,
      artist: catalogue.artist.name,
      title: album.title,
      year: album.year,
      cover: album.cover,
      musicBrainzUrl: album.musicBrainzUrl,
      status: "pending",
      createdAt: new Date().toISOString()
    };
    discoveries.push(item);
    catalogueReleases.set(item.id, {
      id: item.id,
      artist: item.artist,
      title: item.title,
      year: item.year
    });
    await saveDiscoveries();
    return item;
  }
  throw new Error("No new connected-artist album was available today.");
}

async function acquireRandomSimilarAlbum() {
  if (testMode && process.env.TEST_SIMILAR_RELEASE) {
    const release = JSON.parse(process.env.TEST_SIMILAR_RELEASE);
    catalogueReleases.set(release.id, release);
    return queueAlbum(release.id, release, "discovery");
  }
  const item = await generateDiscovery({ force: true });
  item.status = "approved";
  item.reviewedAt = new Date().toISOString();
  await saveDiscoveries();
  return queueAlbum(item.id, catalogueReleases.get(item.id), "discovery");
}

async function musicBrainz(path) {
  const waitMs = Math.max(0, 1100 - (Date.now() - lastMusicBrainzRequestAt));
  if (waitMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs));
  lastMusicBrainzRequestAt = Date.now();
  const response = await fetchWithRetry(`https://musicbrainz.org/ws/2${path}`, {
    headers: {
      "accept": "application/json",
      "user-agent": "GatewayMusicBrowser/0.1 (local music library browser)"
    },
    timeoutMs: 30_000
  }, "MusicBrainz");
  return response.json();
}

async function searchCatalogue(query) {
  const key = normalized(query);
  if (!key) return { artist: null, albums: [] };
  if (catalogueCache.has(key)) return catalogueCache.get(key);

  const artistSearch = await musicBrainz(`/artist?query=${encodeURIComponent(`artist:${query}`)}&fmt=json&limit=5`);
  const candidates = artistSearch.artists || [];
  const artist = candidates.find((item) => normalized(item.name) === key) || candidates[0];
  if (!artist) return { artist: null, albums: [] };

  const groups = await musicBrainz(`/release-group?artist=${artist.id}&type=album&fmt=json&limit=100`);
  const ownedAlbums = library.albums
    .filter((album) => normalized(album.artist) === normalized(artist.name))
    .map((album) => ({ title: normalized(album.title), id: album.id }));
  const seen = new Set();
  const albums = (groups["release-groups"] || [])
    .filter((album) => album["primary-type"] === "Album")
    .filter((album) => (album["secondary-types"] || []).length === 0)
    .filter((album) => {
      const albumKey = normalized(album.title);
      if (seen.has(albumKey)) return false;
      seen.add(albumKey);
      return true;
    })
    .map((album) => {
      const localAlbum = ownedAlbums.find((owned) => owned.title === normalized(album.title));
      return {
        id: album.id,
        title: album.title,
        year: album["first-release-date"]?.slice(0, 4) || "",
        secondaryTypes: album["secondary-types"] || [],
        owned: Boolean(localAlbum),
        localAlbumId: localAlbum?.id || null,
        downloadable: true,
        cover: `https://coverartarchive.org/release-group/${album.id}/front-250`,
        musicBrainzUrl: `https://musicbrainz.org/release-group/${album.id}`
      };
    })
    .sort((left, right) => (right.year || "0000").localeCompare(left.year || "0000"));
  for (const album of albums) {
    catalogueReleases.set(album.id, {
      id: album.id,
      artist: artist.name,
      title: album.title,
      year: album.year
    });
  }
  const result = {
    artist: {
      id: artist.id,
      name: artist.name,
      country: artist.country || "",
      disambiguation: artist.disambiguation || ""
    },
    albums
  };
  catalogueCache.set(key, result);
  return result;
}

async function catalogueAlbumPreview(id) {
  const known = catalogueReleases.get(id);
  if (!known) throw Object.assign(new Error("Search for this album again before opening it."), { status: 404 });
  const response = await musicBrainz(`/release?release-group=${encodeURIComponent(id)}&inc=recordings+media+artist-credits&fmt=json&limit=100`);
  const candidates = (response.releases || []).filter((release) => (release.media || []).some((medium) => medium.tracks?.length));
  const editionPenalty = (release) => /deluxe|expanded|anniversary|box|super deluxe/i.test(`${release.title} ${release.disambiguation || ""}`) ? 1000 : 0;
  const selected = [...candidates].sort((left, right) =>
    editionPenalty(left) - editionPenalty(right)
    || (left.media || []).length - (right.media || []).length
    || String(left.date || "9999").localeCompare(String(right.date || "9999")))[0];
  if (!selected) throw Object.assign(new Error("MusicBrainz has no track listing for this album."), { status: 404 });
  const tracks = (selected.media || []).flatMap((medium, mediumIndex) => (medium.tracks || []).map((track, trackIndex) => ({
    disc: Number(medium.position) || mediumIndex + 1,
    position: Number(track.position) || trackIndex + 1,
    title: track.recording?.title || track.title || `Track ${trackIndex + 1}`,
    artist: (track.recording?.["artist-credit"] || selected["artist-credit"] || [])
      .map((credit) => credit.name || credit.artist?.name).filter(Boolean).join("") || known.artist,
    duration: Math.round(Number(track.length || track.recording?.length || 0) / 1000)
  })));
  return {
    id,
    artist: known.artist,
    title: known.title,
    year: known.year || selected.date?.slice(0, 4) || "",
    releaseId: selected.id,
    releaseTitle: selected.title,
    country: selected.country || "",
    cover: `https://coverartarchive.org/release-group/${id}/front-500`,
    musicBrainzUrl: `https://musicbrainz.org/release/${selected.id}`,
    tracks
  };
}

async function fetchRecommendations(artists) {
  const cacheKey = artists.slice(0, 4).map(normalized).sort().join("\0");
  const cached = recommendationCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < recommendationCacheTtl) return cached.value;

  const seen = new Set(artists.map((artist) => artist.toLowerCase()));
  const result = [];
  for (const artist of artists.slice(0, 4)) {
    try {
      const url = `https://www.last.fm/music/${encodeURIComponent(artist).replaceAll("%20", "+")}/+similar`;
      const html = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 GatewayMusicBrowser/0.1" },
        signal: AbortSignal.timeout(4000)
      }).then((res) => res.text());
      const blocks = html.split("similar-artists-item-name").slice(1);
      for (const block of blocks) {
        const match = block.match(/href="\/music\/([^"]+)"/);
        if (!match) continue;
        const name = decodeHtml(decodeURIComponent(match[1].replaceAll("+", " ")));
        if (seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        result.push({
          artist: name,
          basedOn: artist,
          href: `https://www.last.fm/music/${match[1]}`
        });
        if (result.length >= 18) {
          recommendationCache.set(cacheKey, { createdAt: Date.now(), value: result });
          return result;
        }
      }
    } catch (error) {
      console.error(`Recommendation lookup failed for ${artist}:`, error.message);
    }
  }
  recommendationCache.set(cacheKey, { createdAt: Date.now(), value: result });
  return result;
}

async function prepareFeaturedRecommendations() {
  featuredIndex = library.albums.length ? Math.floor(Math.random() * library.albums.length) : -1;
  const featured = library.albums[featuredIndex];
  recommendations = featured && !testMode ? await fetchRecommendations([featured.artist]) : [];
  return { featuredIndex, recommendations };
}

async function coverFor(id, response) {
  const source = await openPublishedMedia(id, library.tracks, root);
  if (!source) return sendJson(response, 404, { error: "Track not found" });
  try {
    await mkdir(cacheDir, { recursive: true });
    const cacheName = `${Buffer.from(id).toString("base64url")}.jpg`;
    const target = join(cacheDir, cacheName);
    if (!existsSync(target)) {
      try {
        await execFileAsync("ffmpeg", ["-v", "error", "-i", `/proc/${process.pid}/fd/${source.fd}`, "-an", "-frames:v", "1", "-y", target]);
      } catch {
        return sendJson(response, 404, { error: "Cover not found" });
      }
    }
    response.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" });
    createReadStream(target).pipe(response);
  } finally {
    await source.close();
  }
}

async function streamAudio(id, request, response) {
  const source = await openPublishedMedia(id, library.tracks, root);
  if (!source) return sendJson(response, 404, { error: "Track not found" });
  const info = await source.stat();
  const range = request.headers.range;
  const contentTypes = { ".flac": "audio/flac", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav" };
  const contentType = contentTypes[extname(id).toLowerCase()] || "application/octet-stream";
  if (!range) {
    response.writeHead(200, { "content-type": contentType, "content-length": info.size, "accept-ranges": "bytes" });
    return source.createReadStream().pipe(response);
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) {
    await source.close();
    response.writeHead(416, { "content-range": `bytes */${info.size}` });
    return response.end();
  }
  const [, startText, endText] = match;
  const start = Number(startText);
  const end = endText ? Math.min(Number(endText), info.size - 1) : info.size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
    await source.close();
    response.writeHead(416, { "content-range": `bytes */${info.size}` });
    return response.end();
  }
  response.writeHead(206, {
    "content-type": contentType,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${info.size}`,
    "accept-ranges": "bytes"
  });
  source.createReadStream({ start, end }).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === "/api/library") return sendJson(response, 200, library);
    if (url.pathname === "/api/bootstrap") {
      return sendJson(response, 200, {
        library,
        featuredIndex,
        recommendations,
        discoveries,
        acquisitions: [...acquisitionState.values()],
        repairApprovals: [],
        lookupRateLimit: lookupRateLimitState(),
        libraryScan: {
          updatedAt: library.updatedAt,
          inProgress: Boolean(libraryScanPromise),
          intervalMs: libraryScanIntervalMs
        }
      });
    }
    if (url.pathname === "/api/recommendations") {
      const artist = url.searchParams.get("artist")?.trim();
      return sendJson(response, 200, artist ? await fetchRecommendations([artist]) : recommendations);
    }
    if (url.pathname === "/api/recommendations/refresh" && request.method === "POST") {
      return sendJson(response, 200, await prepareFeaturedRecommendations());
    }
    if (url.pathname === "/api/download-album") return downloadAlbum(url.searchParams.get("id") || "", response);
    if (url.pathname === "/api/library/album-metadata" && request.method === "PUT") {
      try {
        return sendJson(response, 200, await editAlbumMetadata(url.searchParams.get("id") || "", await readJsonRequest(request)));
      } catch (error) {
        return sendJson(response, error.status || 500, { error: error.message });
      }
    }
    if (url.pathname === "/api/acquire-album" && request.method === "POST") {
      return acquireAlbum(url.searchParams.get("id") || "", response);
    }
    if (url.pathname === "/api/acquisitions") {
      return sendJson(response, 200, [...acquisitionState.values()]);
    }
    if (url.pathname === "/api/acquisitions/staging") {
      return sendJson(response, 200, await stagingInventory());
    }
    if (url.pathname === "/api/acquisitions/staging/quarantine-preview") {
      return sendJson(response, 200, quarantinePreview(await stagingInventory()));
    }
    if (url.pathname === "/api/acquisitions/history" && request.method === "DELETE") {
      return sendJson(response, 200, { removed: clearAcquisitionHistory() });
    }
    if (url.pathname === "/api/shadow-albums") {
      return sendJson(response, 200, [...shadowAlbums.values()]);
    }
    if (url.pathname === "/api/shadow-albums/reconcile" && request.method === "POST") {
      const id = url.searchParams.get("id");
      if (!id) {
        void reconcileShadowBatch();
        return sendJson(response, 202, { status: shadowReconciliationPromise ? "running" : "queued" });
      }
      try {
        const result = await identifyShadowAlbum(id);
        await refreshPublishedLibrary();
        return sendJson(response, 200, result);
      } catch (error) {
        return sendJson(response, error.status || 502, { error: error.message });
      }
    }
    if (url.pathname === "/api/shadow-albums/acquire" && request.method === "POST") {
      const record = shadowAlbums.get(url.searchParams.get("id") || "");
      if (!record) return sendJson(response, 404, { error: "Shadow album not found." });
      if (!record.authoritative) return sendJson(response, 409, { error: "Identify the album release before acquiring tracks." });
      if (record.published) return sendJson(response, 409, { error: "Album is already complete and published." });
      const state = queueNextShadowTrack(record);
      return state
        ? sendJson(response, 202, state)
        : sendJson(response, 409, { error: "No missing track is available to acquire." });
    }
    if (url.pathname === "/api/download-approvals") {
      return sendJson(response, 410, { error: "Manual repair approvals were replaced by shadow-album reconciliation." });
    }
    if (url.pathname.startsWith("/api/download-approvals/")) {
      return sendJson(response, 410, { error: "Manual repair approvals were replaced by shadow-album reconciliation." });
    }
    if (url.pathname === "/api/download-approvals/review") {
      try {
        const result = await reviewRepair(url.searchParams.get("id") || "");
        return result ? sendJson(response, 200, result) : sendJson(response, 404, { error: "Pending approval not found" });
      } catch (error) {
        return sendJson(response, error.status || 502, { error: error.message });
      }
    }
    if (url.pathname === "/api/download-approvals/approve" && request.method === "POST") {
      const result = await approveRepair(url.searchParams.get("id") || "");
      return result ? sendJson(response, 202, result) : sendJson(response, 404, { error: "Pending approval not found" });
    }
    if (url.pathname === "/api/download-approvals/track-decision" && request.method === "POST") {
      try {
        const result = await applyRepairTrackDecision(
          url.searchParams.get("id") || "",
          Number(url.searchParams.get("disc")),
          Number(url.searchParams.get("track")),
          url.searchParams.get("choice") || ""
        );
        return result ? sendJson(response, 202, result) : sendJson(response, 404, { error: "Pending approval not found" });
      } catch (error) {
        return sendJson(response, error.status || 500, { error: error.message });
      }
    }
    if (url.pathname === "/api/download-approvals/dismiss" && request.method === "POST") {
      const result = await dismissRepair(url.searchParams.get("id") || "");
      return result ? sendJson(response, 200, result) : sendJson(response, 404, { error: "Pending approval not found" });
    }
    if (url.pathname === "/api/rate-limit") return sendJson(response, 200, lookupRateLimitState());
    if (url.pathname === "/api/acquisitions/cancel" && request.method === "POST") {
      const item = cancelAcquisition(url.searchParams.get("id") || "");
      return item
        ? sendJson(response, 202, item)
        : sendJson(response, 404, { error: "Active or queued download not found" });
    }
    if (url.pathname === "/api/acquisitions/prioritize" && request.method === "POST") {
      const item = prioritizeAcquisition(url.searchParams.get("id") || "");
      return item
        ? sendJson(response, 202, item)
        : sendJson(response, 404, { error: "Queued download not found" });
    }
    if (url.pathname === "/api/library/repair-incomplete" && request.method === "POST") {
      return sendJson(response, 410, { error: "Legacy repair was replaced by shadow-album reconciliation." });
    }
    if (url.pathname === "/api/library/trash-track" && request.method === "POST") {
      try {
        return sendJson(response, 200, await trashTrack(url.searchParams.get("id") || ""));
      } catch (error) {
        return sendJson(response, 404, { error: error.message });
      }
    }
    if (url.pathname === "/api/library/trash-album" && request.method === "POST") {
      try {
        return sendJson(response, 200, await trashAlbum(url.searchParams.get("id") || ""));
      } catch (error) {
        return sendJson(response, 404, { error: error.message });
      }
    }
    if (url.pathname === "/api/discoveries" && request.method === "GET") {
      return sendJson(response, 200, discoveries);
    }
    if (url.pathname === "/api/discoveries/generate" && request.method === "POST") {
      try {
        return sendJson(response, 201, await generateDiscovery({ force: url.searchParams.get("force") === "true" }));
      } catch (error) {
        return sendJson(response, 503, { error: error.message });
      }
    }
    if (url.pathname === "/api/discoveries/acquire-random" && request.method === "POST") {
      try {
        return sendJson(response, 202, await acquireRandomSimilarAlbum());
      } catch (error) {
        return sendJson(response, 503, { error: error.message });
      }
    }
    if (url.pathname === "/api/discoveries/dismiss" && request.method === "POST") {
      const item = discoveries.find((entry) => entry.id === url.searchParams.get("id"));
      if (!item) return sendJson(response, 404, { error: "Discovery item not found" });
      item.status = "dismissed";
      item.reviewedAt = new Date().toISOString();
      await saveDiscoveries();
      return sendJson(response, 200, item);
    }
    if (url.pathname === "/api/discoveries/approve" && request.method === "POST") {
      const item = discoveries.find((entry) => entry.id === url.searchParams.get("id"));
      if (!item) return sendJson(response, 404, { error: "Discovery item not found" });
      item.status = "approved";
      item.reviewedAt = new Date().toISOString();
      await saveDiscoveries();
      return acquireAlbum(item.id, response, "discovery");
    }
    if (url.pathname === "/api/catalog/search") {
      const query = url.searchParams.get("q") || "";
      if (query.trim().length < 2) return sendJson(response, 200, { artist: null, albums: [] });
      return sendJson(response, 200, await searchCatalogue(query));
    }
    if (url.pathname === "/api/catalog/album") {
      try {
        return sendJson(response, 200, await catalogueAlbumPreview(url.searchParams.get("id") || ""));
      } catch (error) {
        return sendJson(response, error.status || 503, { error: error.message });
      }
    }
    if (testMode && url.pathname === "/api/test/catalogue" && request.method === "POST") {
      const release = {
        id: url.searchParams.get("id") || "test-release",
        artist: url.searchParams.get("artist") || "Test Artist",
        title: url.searchParams.get("title") || "Test Album",
        year: url.searchParams.get("year") || "2024"
      };
      catalogueReleases.set(release.id, release);
      return sendJson(response, 201, release);
    }
    if (testMode && url.pathname === "/api/test/rate-limit" && request.method === "POST") {
      triggerLookupRateLimit(Number(url.searchParams.get("ms") || 500));
      return sendJson(response, 200, lookupRateLimitState());
    }
    if (url.pathname === "/api/rescan" && request.method === "POST") {
      await scanLibrary();
      return sendJson(response, 200, library);
    }
    if (url.pathname === "/api/cover") return coverFor(url.searchParams.get("id") || "", response);
    if (url.pathname === "/api/audio") return streamAudio(url.searchParams.get("id") || "", request, response);

    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const path = resolve(publicDir, file);
    if (!path.startsWith(publicDir) || !existsSync(path)) return sendJson(response, 404, { error: "Not found" });
    const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
    const extension = extname(path);
    response.writeHead(200, {
      "content-type": `${types[extension] || "application/octet-stream"}; charset=utf-8`,
      "cache-control": [".html", ".css", ".js"].includes(extension) ? "no-cache" : "public, max-age=300"
    });
    createReadStream(path).pipe(response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Internal server error" });
  }
});

await loadDiscoveries();
await loadAcquisitions();
await loadRepairPolicy();
await loadShadowAlbums();
await loadFirstReleaseYears();
await loadCataloguedLibrarySnapshot();
await loadLookupRateLimit();
server.listen(port, "0.0.0.0", () => {
  console.log(`Format listening on http://0.0.0.0:${port}`);
});
void scanLibrary()
  .then(() => {
    initialLibraryScanComplete = true;
    reconcileCompletedAcquisitions();
    processAcquisitionQueue();
    void enrichFirstReleaseYears().catch((error) => console.error("First-release year enrichment failed:", error.message));
    if (shadowRepairEnabled) {
      void maintainShadowAlbums().catch((error) => console.error("Initial shadow maintenance failed:", error.message));
    }
  })
  .catch((error) => console.error("Initial library scan failed:", error.message));
const libraryScanTimer = setInterval(() => {
  void scanLibrary().catch((error) => console.error("Scheduled library scan failed:", error.message));
}, libraryScanIntervalMs);
libraryScanTimer.unref();
const libraryMaintenanceTimer = setInterval(() => {
  void enrichFirstReleaseYears({ revalidate: true })
    .catch((error) => console.error("Scheduled first-release year validation failed:", error.message));
  if (shadowRepairEnabled) {
    void maintainShadowAlbums().catch((error) => console.error("Scheduled shadow maintenance failed:", error.message));
  }
}, libraryMaintenanceIntervalMs);
libraryMaintenanceTimer.unref();
