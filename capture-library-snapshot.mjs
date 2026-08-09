import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const dataDir = resolve(process.env.DATA_DIR || "/home/jake/.local/share/gateway-music-browser");
const destination = join(dataDir, "library-snapshot.json");
const endpoint = process.env.SIGNAL_LIBRARY_URL || "http://127.0.0.1:4534/api/library";
const response = await fetch(endpoint);
if (!response.ok) throw new Error(`Signal library returned HTTP ${response.status}`);
const library = await response.json();
if (!Array.isArray(library.albums) || !Array.isArray(library.tracks) || !library.updatedAt) throw new Error("Signal returned an invalid library snapshot.");
await mkdir(dirname(destination), { recursive: true });
const temporary = `${destination}.tmp`;
await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, library }, null, 2)}\n`, "utf8");
await rename(temporary, destination);
console.log(`Saved ${library.albums.length} albums and ${library.tracks.length} tracks to ${destination}`);
