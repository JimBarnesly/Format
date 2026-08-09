import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const dataDir = resolve(process.env.DATA_DIR || "/home/jake/.local/share/gateway-music-browser");
const acquisitionFile = join(dataDir, "acquisitions.json");
const managedFile = join(dataDir, "managed-albums.json");
const archiveDir = join(dataDir, "archives");
const normalized = (value) => String(value || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const albumKey = (artist, title) => `${normalized(artist)}\0${normalized(title)}`;

await mkdir(archiveDir, { recursive: true });
const saved = JSON.parse(await readFile(acquisitionFile, "utf8"));
const timestamp = new Date().toISOString().replaceAll(":", "-");
const archive = join(archiveDir, `acquisitions-before-v2-${timestamp}.json`);
await copyFile(acquisitionFile, archive);

let managed = [];
try {
  managed = JSON.parse(await readFile(managedFile, "utf8")).albums || [];
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const managedSet = new Set(managed);
for (const item of saved.items || []) {
  if (item.status === "complete" && item.message === "Added to your library.") managedSet.add(albumKey(item.artist, item.title));
}

const retained = (saved.items || []).filter((item) => ["queued", "resolving", "running"].includes(item.status)).map((item) => ({
  ...item,
  status: "queued",
  message: "Queued after downloader v2 migration.",
  startedAt: null,
  finishedAt: null,
  progress: 0,
  trackNumber: 0,
  currentTrack: "",
  cancelRequested: undefined,
  timeoutRequested: undefined,
  origin: item.origin || "manual",
  priority: item.priority || 10
}));
const temporary = `${acquisitionFile}.tmp`;
await writeFile(temporary, `${JSON.stringify({ schemaVersion: 2, items: retained }, null, 2)}\n`, "utf8");
await rename(temporary, acquisitionFile);
await mkdir(dirname(managedFile), { recursive: true });
await writeFile(managedFile, `${JSON.stringify({ schemaVersion: 1, albums: [...managedSet] }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ archive, retainedJobs: retained.length, removedHistory: (saved.items || []).length - retained.length, managedAlbums: managedSet.size }, null, 2));
