import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let temporary;
let musicRoot;
let baseUrl;
let serverProcess;

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function flac(path, { artist, album, title, year, track, total }) {
  await mkdir(join(path, ".."), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "0.05",
    "-metadata", `artist=${artist}`, "-metadata", `album_artist=${artist}`,
    "-metadata", `album=${album}`, "-metadata", `title=${title}`, "-metadata", `date=${year}`,
    "-metadata", `track=${track}`, "-metadata", `tracktotal=${total}`,
    "-metadata", "disc=1", "-metadata", "disctotal=1", "-y", path
  ]);
}

async function json(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { response, body: await response.json() };
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition");
}

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), "signal-test-"));
  musicRoot = join(temporary, "music");
  const fixtureDir = join(musicRoot, "Fixture Artist", "Fixture Album");
  await flac(join(fixtureDir, "01.flac"), { artist: "Fixture Artist", album: "Fixture Album", title: "One", year: "2020", track: 1, total: 3 });
  await flac(join(fixtureDir, "02.flac"), { artist: "Fixture Artist", album: "Fixture Album", title: "Two", year: "2020", track: 2, total: 3 });
  await flac(join(fixtureDir, "03.flac"), { artist: "Fixture Artist", album: "Fixture Album", title: "Three", year: "2020", track: 3, total: 3 });
  await flac(join(fixtureDir, "rogue-reissue.flac"), { artist: "Fixture Artist", album: "Fixture Album", title: "One (Reissue)", year: "2021", track: 1, total: 29 });

  const wrongMetadata = join(musicRoot, "Sola Rosa", "Haunted Out-Takes", "06. Awish.flac");
  await flac(wrongMetadata, { artist: "Sola Rosa", album: "Haunted Out-Takes", title: "Awish", year: "2003", track: 6, total: 11 });
  const wrongHash = createHash("sha256").update(await readFile(wrongMetadata)).digest("hex");
  const correctionFile = join(temporary, "metadata-corrections.json");
  await writeFile(correctionFile, JSON.stringify({ schemaVersion: 1, corrections: [{
    sha256: wrongHash, artist: "Sola Rosa", albumArtist: "Sola Rosa", album: "Get It Together",
    title: "The Ace of Space", date: "2009", track: "1", trackTotal: "11", disc: "1", discTotal: "1",
    relativePath: "Sola Rosa/Get It Together/01. The Ace of Space.flac"
  }] }));

  const acquisitionFixtures = join(temporary, "acquisition-fixtures");
  for (let track = 1; track <= 2; track += 1) {
    await flac(join(acquisitionFixtures, `${track}.flac`), {
      artist: "Test Artist", album: "Test Album", title: `Track ${track}`, year: "2024", track, total: 2
    });
  }
  const similarFixtures = join(temporary, "similar-fixtures");
  await flac(join(similarFixtures, "1.flac"), {
    artist: "Similar Artist", album: "Similar Album", title: "Similar Track", year: "2025", track: 1, total: 1
  });
  const flakyFixtures = join(temporary, "flaky-fixtures");
  await flac(join(flakyFixtures, "1.flac"), {
    artist: "Flaky Artist", album: "Flaky Album", title: "Recovered Track", year: "2025", track: 1, total: 1
  });
  const rateFixtures = join(temporary, "rate-fixtures");
  await flac(join(rateFixtures, "1.flac"), {
    artist: "Rate Artist", album: "Rate Album", title: "Delayed Track", year: "2025", track: 1, total: 1
  });
  const mock = join(temporary, "mock-spotiflac.sh");
  await writeFile(mock, `#!/bin/sh\nset -eu\ncase "$1" in\n  *slow-release*) sleep 30; exit 0 ;;\n  *empty-release*) exit 0 ;;\n  *rate-release*) out="$2/Rate Artist/Rate Album/[2025] Rate Album"; mkdir -p "$out"; cp "$RATE_FIXTURES/1.flac" "$out/01. Delayed Track.flac"; exit 0 ;;\n  *flaky-release*) if [ ! -f "$FLAKY_MARKER" ]; then touch "$FLAKY_MARKER"; sleep 5; fi; out="$2/Flaky Artist/Flaky Album/[2025] Flaky Album"; mkdir -p "$out"; cp "$FLAKY_FIXTURES/1.flac" "$out/01. Recovered Track.flac"; exit 0 ;;\n  *similar-release*) out="$2/Similar Artist/Similar Album/[2025] Similar Album"; mkdir -p "$out"; cp "$SIMILAR_FIXTURES/1.flac" "$out/01. Similar Track.flac"; exit 0 ;;\nesac\nout="$2/Test Artist/Test Album/[2024] Test Album"\nmkdir -p "$out"\ncp "$MOCK_FIXTURES/1.flac" "$out/01. Track 1.flac"\ncp "$MOCK_FIXTURES/2.flac" "$out/02. Track 2.flac"\n`, "utf8");
  await chmod(mock, 0o755);

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: "test", PORT: String(port), MUSIC_ROOT: musicRoot,
      DATA_DIR: join(temporary, "data"), CACHE_DIR: join(temporary, "cache"),
      DOWNLOAD_ROOT: join(musicRoot, "SpotiFLAC"), SPOTIFLAC_BIN: mock,
      TEST_ACQUISITION_SOURCE_URL: "https://music.apple.com/nz/album/test/{id}",
      METADATA_CORRECTIONS_FILE: correctionFile,
      MOCK_FIXTURES: acquisitionFixtures,
      SIMILAR_FIXTURES: similarFixtures,
      FLAKY_FIXTURES: flakyFixtures,
      RATE_FIXTURES: rateFixtures,
      FLAKY_MARKER: join(temporary, "flaky-marker"),
      ACQUISITION_STALL_TIMEOUT_MS: "300",
      ACQUISITION_MAX_ATTEMPTS: "2",
      TEST_SIMILAR_RELEASE: JSON.stringify({ id: "similar-release", artist: "Similar Artist", title: "Similar Album", year: "2025" })
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitFor(async () => {
    try { return (await fetch(`${baseUrl}/api/bootstrap`)).ok; } catch { return false; }
  });
  await waitFor(async () => !(await json("/api/bootstrap")).body.libraryScan.inProgress);
});

after(async () => {
  serverProcess?.kill("SIGTERM");
});

test("serves the application and bootstrap state", async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Search artists, albums, songs, genres/);
  assert.match(html, /id="rate-limit-clock"/);
  assert.match(html, /id="download-queue"/);
  const { response, body } = await json("/api/bootstrap");
  assert.equal(response.status, 200);
  assert.equal(body.libraryScan.inProgress, false);
  assert.ok(body.library.updatedAt);
});

test("groups inconsistent release years and ignores rogue track totals", async () => {
  const { body } = await json("/api/library");
  const albums = body.albums.filter((album) => album.artist === "Fixture Artist" && album.title === "Fixture Album");
  assert.equal(albums.length, 1);
  assert.equal(albums[0].expectedTracks, 3);
  assert.equal(albums[0].incomplete, false);
  assert.deepEqual(albums[0].missingTracks, []);
});

test("applies hash-verified metadata corrections and relocates the track", async () => {
  const { body } = await json("/api/library");
  const track = body.tracks.find((item) => item.title === "The Ace of Space");
  assert.ok(track);
  assert.equal(track.artist, "Sola Rosa");
  assert.equal(track.album, "Get It Together");
  assert.equal(track.track, 1);
  assert.equal(body.tracks.some((item) => item.title === "Awish"), false);
});

test("streams complete and ranged audio safely", async () => {
  const { body } = await json("/api/library");
  const track = body.tracks.find((item) => item.artist === "Fixture Artist");
  const full = await fetch(`${baseUrl}/api/audio?id=${encodeURIComponent(track.id)}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.match(full.headers.get("content-type"), /^audio\/flac/);
  const partial = await fetch(`${baseUrl}/api/audio?id=${encodeURIComponent(track.id)}`, { headers: { range: "bytes=0-15" } });
  assert.equal(partial.status, 206);
  assert.equal((await partial.arrayBuffer()).byteLength, 16);
  assert.equal((await fetch(`${baseUrl}/api/audio?id=${encodeURIComponent(track.id)}`, { headers: { range: "bytes=999999-" } })).status, 416);
  assert.equal((await fetch(`${baseUrl}/api/audio?id=../../etc/passwd`)).status, 404);
});

test("creates an owned-album archive", async () => {
  const { body } = await json("/api/library");
  const album = body.albums.find((item) => item.artist === "Fixture Artist");
  const response = await fetch(`${baseUrl}/api/download-album?id=${encodeURIComponent(album.id)}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /Fixture Artist - Fixture Album/);
  assert.ok((await response.arrayBuffer()).byteLength > 0);
});

test("holds queued albums during a catalogue rate limit and resumes at zero", async () => {
  await json("/api/test/catalogue?id=rate-release&artist=Rate%20Artist&title=Rate%20Album&year=2025", { method: "POST" });
  const limited = await json("/api/test/rate-limit?ms=500", { method: "POST" });
  assert.equal(limited.body.active, true);
  await json("/api/acquire-album?id=rate-release", { method: "POST" });
  const during = (await json("/api/acquisitions")).body.find((item) => item.id === "rate-release");
  assert.equal(during.status, "queued");
  await waitFor(async () => {
    const { body } = await json("/api/acquisitions");
    return body.find((item) => item.id === "rate-release")?.status === "complete";
  });
  assert.equal((await json("/api/rate-limit")).body.active, false);
});

test("automatically retries a stalled provider and completes the album", async () => {
  await json("/api/test/catalogue?id=flaky-release&artist=Flaky%20Artist&title=Flaky%20Album&year=2025", { method: "POST" });
  assert.equal((await json("/api/acquire-album?id=flaky-release", { method: "POST" })).response.status, 202);
  const completed = await waitFor(async () => {
    const { body } = await json("/api/acquisitions");
    return body.find((item) => item.id === "flaky-release" && item.status === "complete");
  });
  assert.equal(completed.message, "Added to your library.");
  assert.equal(completed.attempt, undefined);
  const { body } = await json("/api/library");
  assert.ok(body.albums.some((item) => item.artist === "Flaky Artist" && item.title === "Flaky Album"));
});

test("single-click acquisition becomes a verified library album", async () => {
  let result = await json("/api/test/catalogue?id=test-release&artist=Test%20Artist&title=Test%20Album&year=2024", { method: "POST" });
  assert.equal(result.response.status, 201);
  result = await json("/api/acquire-album?id=test-release", { method: "POST" });
  assert.equal(result.response.status, 202);
  assert.match(result.body.status, /queued|resolving|running/);
  const completed = await waitFor(async () => {
    const { body } = await json("/api/acquisitions");
    return body.find((item) => item.id === "test-release" && item.status === "complete");
  });
  assert.equal(completed.message, "Added to your library.");
  const { body } = await json("/api/library");
  const album = body.albums.find((item) => item.artist === "Test Artist" && item.title === "Test Album");
  assert.ok(album);
  assert.equal(album.incomplete, false);
  assert.equal(album.trackIds.length, 2);
});

test("random similar-album acquisition downloads and appears in the library", async () => {
  const queued = await json("/api/discoveries/acquire-random", { method: "POST" });
  assert.equal(queued.response.status, 202);
  assert.equal(queued.body.id, "similar-release");
  await waitFor(async () => {
    const { body } = await json("/api/acquisitions");
    return body.find((item) => item.id === "similar-release")?.status === "complete";
  });
  const { body } = await json("/api/library");
  const album = body.albums.find((item) => item.artist === "Similar Artist" && item.title === "Similar Album");
  assert.ok(album);
  assert.equal(album.incomplete, false);
});

test("does not report success when a downloader exits without files", async () => {
  await json("/api/test/catalogue?id=empty-release&artist=Empty%20Artist&title=Empty%20Album", { method: "POST" });
  const queued = await json("/api/acquire-album?id=empty-release", { method: "POST" });
  assert.equal(queued.response.status, 202);
  const failed = await waitFor(async () => {
    const { body } = await json("/api/acquisitions");
    return body.find((item) => item.id === "empty-release" && item.status === "failed");
  });
  assert.match(failed.message, /without adding any album files/);
});

test("rescans new files and reports genuinely missing tracks", async () => {
  const folder = join(musicRoot, "Partial Artist", "Partial Album");
  await flac(join(folder, "01.flac"), { artist: "Partial Artist", album: "Partial Album", title: "One", year: "2025", track: 1, total: 3 });
  await flac(join(folder, "03.flac"), { artist: "Partial Artist", album: "Partial Album", title: "Three", year: "2025", track: 3, total: 3 });
  const { response, body } = await json("/api/rescan", { method: "POST" });
  assert.equal(response.status, 200);
  const album = body.albums.find((item) => item.artist === "Partial Artist");
  assert.equal(album.incomplete, true);
  assert.deepEqual(album.missingTracks, ["1:2"]);
});

test("cancels active and queued acquisitions without downloading them", async () => {
  for (const id of ["slow-release", "queued-release"]) {
    await json(`/api/test/catalogue?id=${id}&artist=Cancel%20Artist&title=${id}`, { method: "POST" });
    assert.equal((await json(`/api/acquire-album?id=${id}`, { method: "POST" })).response.status, 202);
  }
  await waitFor(async () => {
    const { body } = await json("/api/acquisitions");
    return body.find((item) => item.id === "slow-release")?.status === "running";
  });
  assert.equal((await json("/api/acquisitions/cancel?id=queued-release", { method: "POST" })).response.status, 202);
  assert.equal((await json("/api/acquisitions/cancel?id=slow-release", { method: "POST" })).response.status, 202);
  await waitFor(async () => {
    const { body } = await json("/api/acquisitions");
    return body.filter((item) => ["slow-release", "queued-release"].includes(item.id)).every((item) => item.status === "cancelled");
  });
});

test("rejects unknown acquisition and deletion targets", async () => {
  assert.equal((await fetch(`${baseUrl}/api/acquire-album?id=missing`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/library/trash-track?id=../../etc/passwd`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/library/trash-album?id=missing`, { method: "POST" })).status, 404);
});
