#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const musicRoot = resolve(process.env.MUSIC_ROOT || "/home/jake/Music");
const stateFile = resolve(process.env.PICARD_AUTOMATION_STATE || "/home/jake/.local/share/gateway-music-browser/picard-automation.json");
const container = process.env.PICARD_AUTOMATION_CONTAINER || "gateway-picard-automation";
const fullIntervalMs = Math.max(60_000, Number(process.env.PICARD_FULL_SCAN_INTERVAL_MS || 86_400_000));
const dryRun = process.argv.includes("--dry-run");
const audioExtensions = new Set([".flac", ".mp3", ".m4a", ".ogg", ".opus", ".wav"]);

async function walk(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    else if (audioExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase())) files.push(path);
  }
  return files;
}

async function snapshotLibrary() {
  const grouped = new Map();
  for (const path of await walk(musicRoot)) {
    const details = await stat(path);
    const folder = dirname(path);
    const signature = `${relative(folder, path)}:${details.size}:${Math.trunc(details.mtimeMs)}`;
    if (!grouped.has(folder)) grouped.set(folder, []);
    grouped.get(folder).push(signature);
  }
  return Object.fromEntries([...grouped].map(([folder, signatures]) => [
    relative(musicRoot, folder), signatures.sort().join("|")
  ]).sort(([left], [right]) => left.localeCompare(right)));
}

async function loadState() {
  try {
    const value = JSON.parse(await readFile(stateFile, "utf8"));
    return value.schemaVersion === 1 ? value : {};
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {};
  }
}

function picardPath(relativeFolder) {
  if (!relativeFolder || relativeFolder.split(sep).includes("..") || /[\r\n"]/.test(relativeFolder)) {
    throw new Error(`Unsafe album folder: ${relativeFolder}`);
  }
  return `/music/${relativeFolder.split(sep).join("/")}`;
}

async function queueAlbum(relativeFolder) {
  const commands = [
    "REMOVE_ALL",
    `LOAD "${picardPath(relativeFolder)}"`,
    "CLUSTER",
    "LOOKUP clustered",
    "SAVE_MATCHED",
    "REMOVE_SAVED",
    "REMOVE_EMPTY",
    "SCAN",
    "SAVE_MATCHED",
    "REMOVE_SAVED",
    "REMOVE_EMPTY"
  ];
  if (dryRun) return;
  // Picard Web exposes Picard's documented command queue through its local
  // FIFO. Writing as the container's unprivileged user avoids starting a
  // second Qt process and reliably targets the already-running instance.
  const sender = 'import sys; open("/run/user/gwb/Picard_v2.13.3_main_pipe_file", "w").write("\\0".join(sys.argv[1:]) + "\\0")';
  await execFileAsync("docker", ["exec", "-u", "gwb", container, "python3", "-c", sender, ...commands], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024
  });
}

const startedAt = new Date();
const current = await snapshotLibrary();
const previous = await loadState();
const previousFull = new Date(previous.lastFullScanAt || 0).getTime();
const fullScan = !Number.isFinite(previousFull) || startedAt.getTime() - previousFull >= fullIntervalMs;
const targets = fullScan
  ? Object.keys(current)
  : Object.keys(current).filter((folder) => !(folder in (previous.albums || {})));

for (const folder of targets) await queueAlbum(folder);

if (!dryRun) {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify({
    schemaVersion: 1,
    lastRunAt: startedAt.toISOString(),
    lastFullScanAt: fullScan ? startedAt.toISOString() : previous.lastFullScanAt,
    queuedAlbums: targets.length,
    mode: fullScan ? "full" : "changed",
    albums: current
  }, null, 2)}\n`, "utf8");
}

console.log(`${dryRun ? "Would queue" : "Queued"} ${targets.length} album folder${targets.length === 1 ? "" : "s"} (${fullScan ? "24-hour full scan" : "new albums"}).`);
