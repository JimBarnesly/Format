import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(process.env.MUSIC_ROOT || "/home/jake/Music");
const downloadRoot = resolve(process.env.DOWNLOAD_ROOT || join(root, "SpotiFLAC"));
const publicDir = resolve("public");
const cacheDir = resolve(process.env.CACHE_DIR || "/home/jake/.cache/gateway-music-browser");
const dataDir = resolve(process.env.DATA_DIR || "/home/jake/.local/share/gateway-music-browser");
const discoveryFile = join(dataDir, "discovery.json");
const acquisitionFile = join(dataDir, "acquisitions.json");
const rateLimitFile = join(dataDir, "lookup-rate-limit.json");
const metadataCorrectionsFile = resolve(process.env.METADATA_CORRECTIONS_FILE || "metadata-corrections.json");
const port = Number(process.env.PORT || 4534);
const testMode = process.env.NODE_ENV === "test";
const spotiflacBin = process.env.SPOTIFLAC_BIN || "spotiflac";
const libraryScanIntervalMs = Math.max(60_000, Number(process.env.LIBRARY_SCAN_INTERVAL_MS || 15 * 60 * 1000));
const libraryMaintenanceIntervalMs = Math.max(60_000, Number(process.env.LIBRARY_MAINTENANCE_INTERVAL_MS || 24 * 60 * 60 * 1000));
const audioExtensions = new Set([".flac", ".mp3", ".m4a", ".ogg", ".opus", ".wav"]);
const catalogueReleases = new Map();
const spotifyResolutionCache = new Map([
  ["eda7c3b6-ab1f-38d8-8685-af46f2341596", "https://open.spotify.com/album/0OxSLFlIitRpIT2s9CIjoX"],
  ["a45cf6c9-cbac-4ab4-a702-7becee40a8e8", "https://open.spotify.com/album/6QVBWX8iAeZTlbGSfRVfYC"],
  ["18037a41-2695-3a8f-a732-f6653a7f125b", "https://open.spotify.com/album/3MANoCcmaHWeXSuWiO3iVo"]
]);
const acquisitionState = new Map();
const acquisitionQueue = [];
let activeAcquisitionId = null;
let activeAcquisitionProcess = null;
let initialLibraryScanComplete = false;
let acquisitionSavePromise = Promise.resolve();
let lookupRetryTimer = null;
let lastMusicBrainzRequestAt = 0;

function terminateProcessTree(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") child.kill("SIGTERM");
  }
}

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
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      throw responseError(response, label);
    } catch (error) {
      lastError = error;
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
    "-v", "error", "-show_entries", "format=duration:format_tags=artist,album_artist,album,title,date,track,tracktotal,disc,disctotal,genre,url",
    "-of", "json", path
  ], { maxBuffer: 1024 * 1024 });
  const data = JSON.parse(stdout);
  const tags = data.format?.tags || {};
  const value = (name, fallback = "") => tags[name] || tags[name.toUpperCase()] || fallback;
  return {
    id: relative(root, path),
    title: value("title", path.split(sep).at(-1).replace(extname(path), "")),
    artist: value("artist", "Unknown artist").replaceAll(";", ", "),
    albumArtist: value("album_artist", value("artist", "Unknown artist")).replaceAll(";", ", "),
    album: value("album", "Unknown album"),
    year: String(value("date")).slice(0, 4),
    track: Number.parseInt(value("track", "0"), 10) || 0,
    trackTotal: Number.parseInt(value("tracktotal", "0"), 10) || 0,
    disc: Number.parseInt(value("disc", "1"), 10) || 1,
    discTotal: Number.parseInt(value("disctotal", "1"), 10) || 1,
    sourceUrl: value("url"),
    genre: value("genre").replaceAll(";", " · "),
    duration: Math.round(Number(data.format?.duration || 0))
  };
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
  const byHash = new Map(corrections.map((correction) => [correction.sha256, correction]));
  const applied = [];
  for (const source of paths) {
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
  const tracks = [];
  for (const path of paths) {
    try {
      tracks.push(await probe(path));
    } catch (error) {
      console.error(`Skipping unreadable audio file: ${path}`, error.message);
    }
  }
  const grouped = new Map();
  for (const track of tracks) {
    // Reissues often carry different DATE tags track-by-track. Treat artist +
    // album as the library identity so one physical album is not split across
    // several cards merely because providers supplied inconsistent years.
    const key = `${track.albumArtist}\0${track.album}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        id: encodeURIComponent(key),
        artist: track.albumArtist,
        title: track.album,
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
  library = { albums, tracks, updatedAt: new Date().toISOString() };
  await prepareFeaturedRecommendations();
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
  await execFileAsync("gio", ["trash", path]);
  await scanLibrary();
  return { trashed: 1, library };
}

async function trashAlbum(id) {
  const album = library.albums.find((item) => item.id === id);
  if (!album) throw new Error("Album not found");
  const paths = album.trackIds.map(safeMusicPath);
  if (paths.some((path) => !path || !existsSync(path))) throw new Error("One or more album tracks were not found");
  for (const path of paths) await execFileAsync("gio", ["trash", path]);
  await scanLibrary();
  return { trashed: paths.length, library };
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
  for (const state of acquisitionState.values()) {
    state.queuePosition = state.status === "queued" ? acquisitionQueue.indexOf(state.id) + 1 : 0;
  }
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
    queueAlbum(item.id, catalogueReleases.get(item.id));
  }
}

function finishAcquisition(state) {
  activeAcquisitionId = null;
  state.queuePosition = 0;
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
  const mbid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(release.id || "")
    ? release.id
    : null;
  let group;
  if (mbid) {
    group = await musicBrainz(`/release-group/${mbid}?inc=artist-credits&fmt=json`);
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

async function runAcquisition(state, release) {
  state.status = "resolving";
  state.message = "Matching the exact MusicBrainz release…";
  state.startedAt = new Date().toISOString();
  void saveAcquisitions();
  let sourceUrl;
  try {
    sourceUrl = await resolveMusicBrainzAlbumSource(release);
  } catch (error) {
    state.status = state.cancelRequested ? "cancelled" : "failed";
    state.message = state.cancelRequested ? "Cancelled by user." : error.message;
    state.finishedAt = new Date().toISOString();
    delete state.cancelRequested;
    finishAcquisition(state);
    return;
  }
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
  state.message = "Starting download…";
  void saveAcquisitions();
  const child = spawn(
    spotiflacBin,
    [sourceUrl, downloadRoot,
      "--service", "qobuz", "amazon", "tidal", "deezer",
      "--quality", "HI_RES_LOSSLESS",
      "--filename-format", "[{year}] {album}/{title}",
      "--use-track-numbers", "--use-artist-subfolders", "--use-album-subfolders",
      "--retries", "2", "--timeout", "600", "--loop", "120"],
    {
      cwd: "/home/jake/.openclaw/skills/spotiflac",
      detached: true,
      env: {
        ...process.env,
        PATH: `/home/jake/.local/bin:${process.env.PATH || ""}`
      },
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
    if (Date.now() - lastProgressAt < 12 * 60 * 1000) return;
    state.timeoutRequested = true;
    state.message = "Provider stalled for 12 minutes; stopping download.";
    void saveAcquisitions();
    terminateProcessTree(child);
  }, 15_000);
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
      state.status = "failed";
      state.message = "Provider stalled for 12 minutes. Retry will use the provider fallback chain.";
      state.finishedAt = new Date().toISOString();
      delete state.timeoutRequested;
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
    const reportedSuccess = code === 0 || code === 10;
    if (reportedSuccess) await scanLibrary();
    const libraryAlbum = library.albums.find((album) =>
      normalized(album.artist) === normalized(state.artist)
      && normalized(album.title) === normalized(state.title)
    );
    state.status = reportedSuccess && libraryAlbum && !libraryAlbum.incomplete ? "complete" : "failed";
    if (state.status === "complete") state.progress = 100;
    state.message = state.status === "complete"
      ? "Added to your library."
      : (tail.match(/(?:Failed|ERROR|Error):?[^\n]*/g)?.at(-1)
        || (reportedSuccess && libraryAlbum?.incomplete
          ? `Downloader finished with ${libraryAlbum.missingTracks.length} missing track${libraryAlbum.missingTracks.length === 1 ? "" : "s"}.`
          : reportedSuccess ? "Downloader exited without adding any album files." : `Download exited with code ${code}.`));
    state.finishedAt = new Date().toISOString();
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
    state.finishedAt = new Date().toISOString();
    state.queuePosition = 0;
    refreshQueuePositions();
    void saveAcquisitions();
    return state;
  }
  state.cancelRequested = true;
  state.automaticRepairSuppressed = true;
  state.message = "Cancelling…";
  void saveAcquisitions();
  terminateProcessTree(activeAcquisitionProcess);
  return state;
}

function processAcquisitionQueue() {
  if (!initialLibraryScanComplete || activeAcquisitionId || acquisitionQueue.length === 0) return;
  const id = acquisitionQueue.shift();
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
  refreshQueuePositions();
  void runAcquisition(state, release);
}

function queueAlbum(id, release) {
  catalogueReleases.set(id, release);
  const current = acquisitionState.get(id);
  if (current && ["queued", "resolving", "running", "complete"].includes(current.status)) return current;
  const state = {
    id,
    artist: release.artist,
    title: release.title,
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
  acquisitionQueue.push(id);
  refreshQueuePositions();
  void saveAcquisitions();
  processAcquisitionQueue();
  return state;
}

function acquireAlbum(id, response) {
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
  return sendJson(response, 202, queueAlbum(id, release));
}

async function repairIncompleteAlbums() {
  await scanLibrary();
  const cancelledAlbums = new Set([...acquisitionState.values()]
    .filter((state) => state.status === "cancelled" && state.automaticRepairSuppressed !== false)
    .map((state) => `${normalized(state.artist)}\0${normalized(state.title)}`));
  const busyAlbums = new Set([...acquisitionState.values()]
    .filter((state) => ["queued", "resolving", "running"].includes(state.status))
    .map((state) => `${normalized(state.artist)}\0${normalized(state.title)}`));
  return library.albums.filter((album) =>
    album.incomplete
    && !cancelledAlbums.has(`${normalized(album.artist)}\0${normalized(album.title)}`)
    && !busyAlbums.has(`${normalized(album.artist)}\0${normalized(album.title)}`)
  ).map((album) => {
    const id = `repair:${album.id}`;
    const state = queueAlbum(id, {
      id,
      artist: album.artist,
      title: album.title,
      year: album.year,
      sourceUrl: album.sourceUrl
    });
    return {
      id,
      artist: album.artist,
      title: album.title,
      missingTracks: album.missingTracks,
      missingDiscs: album.missingDiscs,
      status: state.status
    };
  });
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
  const item = await generateDiscovery({ force: true });
  item.status = "approved";
  item.reviewedAt = new Date().toISOString();
  await saveDiscoveries();
  return queueAlbum(item.id, catalogueReleases.get(item.id));
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
    signal: AbortSignal.timeout(10_000)
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
  const source = safeMusicPath(id);
  if (!source || !existsSync(source)) return sendJson(response, 404, { error: "Track not found" });
  await mkdir(cacheDir, { recursive: true });
  const cacheName = `${Buffer.from(id).toString("base64url")}.jpg`;
  const target = join(cacheDir, cacheName);
  if (!existsSync(target)) {
    try {
      await execFileAsync("ffmpeg", ["-v", "error", "-i", source, "-an", "-frames:v", "1", "-y", target]);
    } catch {
      return sendJson(response, 404, { error: "Cover not found" });
    }
  }
  response.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" });
  createReadStream(target).pipe(response);
}

async function streamAudio(id, request, response) {
  const path = safeMusicPath(id);
  if (!path || !existsSync(path)) return sendJson(response, 404, { error: "Track not found" });
  const info = await stat(path);
  const range = request.headers.range;
  const contentTypes = { ".flac": "audio/flac", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav" };
  const contentType = contentTypes[extname(path).toLowerCase()] || "application/octet-stream";
  if (!range) {
    response.writeHead(200, { "content-type": contentType, "content-length": info.size, "accept-ranges": "bytes" });
    return createReadStream(path).pipe(response);
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { "content-range": `bytes */${info.size}` });
    return response.end();
  }
  const [, startText, endText] = match;
  const start = Number(startText);
  const end = endText ? Math.min(Number(endText), info.size - 1) : info.size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
    response.writeHead(416, { "content-range": `bytes */${info.size}` });
    return response.end();
  }
  response.writeHead(206, {
    "content-type": contentType,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${info.size}`,
    "accept-ranges": "bytes"
  });
  createReadStream(path, { start, end }).pipe(response);
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
    if (url.pathname === "/api/acquire-album" && request.method === "POST") {
      return acquireAlbum(url.searchParams.get("id") || "", response);
    }
    if (url.pathname === "/api/acquisitions") {
      return sendJson(response, 200, [...acquisitionState.values()]);
    }
    if (url.pathname === "/api/rate-limit") return sendJson(response, 200, lookupRateLimitState());
    if (url.pathname === "/api/acquisitions/cancel" && request.method === "POST") {
      const item = cancelAcquisition(url.searchParams.get("id") || "");
      return item
        ? sendJson(response, 202, item)
        : sendJson(response, 404, { error: "Active or queued download not found" });
    }
    if (url.pathname === "/api/library/repair-incomplete" && request.method === "POST") {
      return sendJson(response, 202, await repairIncompleteAlbums());
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
      return acquireAlbum(item.id, response);
    }
    if (url.pathname === "/api/catalog/search") {
      const query = url.searchParams.get("q") || "";
      if (query.trim().length < 2) return sendJson(response, 200, { artist: null, albums: [] });
      return sendJson(response, 200, await searchCatalogue(query));
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
await loadLookupRateLimit();
server.listen(port, "0.0.0.0", () => {
  console.log(`Music browser listening on http://0.0.0.0:${port}`);
});
void scanLibrary()
  .then(() => {
    initialLibraryScanComplete = true;
    reconcileCompletedAcquisitions();
    recoverApprovedDiscoveries();
    processAcquisitionQueue();
  })
  .catch((error) => console.error("Initial library scan failed:", error.message));
const libraryScanTimer = setInterval(() => {
  void scanLibrary().catch((error) => console.error("Scheduled library scan failed:", error.message));
}, libraryScanIntervalMs);
libraryScanTimer.unref();
const libraryMaintenanceTimer = setInterval(() => {
  void repairIncompleteAlbums().catch((error) => console.error("Scheduled library maintenance failed:", error.message));
}, libraryMaintenanceIntervalMs);
libraryMaintenanceTimer.unref();
