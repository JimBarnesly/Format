import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const acquisitionStageMarkerName = ".signal-acquisition.json";

async function contentStats(directory) {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await contentStats(path);
      bytes += nested.bytes;
      files += nested.files;
    } else if (entry.isFile()) {
      bytes += (await stat(path)).size;
      files += 1;
    }
  }
  return { bytes, files };
}

export async function readAcquisitionRecords(acquisitionFile) {
  try {
    const saved = JSON.parse(await readFile(acquisitionFile, "utf8"));
    return (Array.isArray(saved.items) ? saved.items : []).filter((item) => item?.id);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function readStagingInventory({ stagingRoot, acquisitions }) {
  const entries = await readdir(stagingRoot, { withFileTypes: true }).catch((error) =>
    error.code === "ENOENT" ? [] : Promise.reject(error));
  const acquisitionList = acquisitions instanceof Map ? [...acquisitions.values()] : acquisitions;
  const acquisitionsById = new Map(acquisitionList.map((state) => [state.id, state]));
  const acquisitionsByHash = new Map(acquisitionList.map((state) => [
    createHash("sha256").update(state.id).digest("hex"), state
  ]));
  const stages = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const stage = join(stagingRoot, entry.name);
    const correlated = acquisitionsByHash.get(entry.name);
    let marker = null;
    let markerError = null;
    try {
      marker = JSON.parse(await readFile(join(stage, acquisitionStageMarkerName), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") markerError = error.message;
    }
    const markerHash = marker?.acquisitionId
      ? createHash("sha256").update(marker.acquisitionId).digest("hex")
      : null;
    const markerState = marker?.acquisitionId ? acquisitionsById.get(marker.acquisitionId) : null;
    const classification = markerError || (marker && markerHash !== entry.name)
      ? "invalid_marker"
      : marker && markerState ? "owned"
        : marker ? "orphaned"
          : correlated ? "legacy_correlated" : "orphaned";
    stages.push({
      directory: entry.name,
      classification,
      acquisitionId: marker?.acquisitionId || correlated?.id || null,
      acquisitionStatus: markerState?.status || correlated?.status || null,
      markerPresent: Boolean(marker),
      markerError,
      ...await contentStats(stage)
    });
  }
  const totals = stages.reduce((result, stage) => {
    result.bytes += stage.bytes;
    result.files += stage.files;
    result[stage.classification] = (result[stage.classification] || 0) + 1;
    return result;
  }, { stages: stages.length, bytes: 0, files: 0 });
  return { generatedAt: new Date().toISOString(), totals, stages };
}
