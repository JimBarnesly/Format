import { existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const quarantineManifestName = ".signal-quarantine.json";
export const quarantineIntentSuffix = ".signal-quarantine-intent.json";
export const restoreIntentSuffix = ".signal-restore-intent.json";

const recoverableClassifications = new Set(["owned", "legacy_correlated"]);
const terminalStatuses = new Set(["failed", "cancelled"]);

export function quarantinePreview(inventory) {
  const stages = [...(inventory.stages || [])]
    .map((stage) => ({
      directory: stage.directory,
      classification: stage.classification,
      acquisitionId: stage.acquisitionId || null,
      acquisitionStatus: stage.acquisitionStatus || null,
      markerPresent: Boolean(stage.markerPresent),
      markerError: stage.markerError || null,
      bytes: Number(stage.bytes || 0),
      files: Number(stage.files || 0),
      eligible: recoverableClassifications.has(stage.classification)
        && terminalStatuses.has(stage.acquisitionStatus)
    }))
    .sort((left, right) => left.directory.localeCompare(right.directory));
  const inventoryToken = createHash("sha256").update(JSON.stringify(stages)).digest("hex");
  return {
    generatedAt: new Date().toISOString(),
    inventoryToken,
    totals: {
      stages: stages.length,
      eligible: stages.filter((stage) => stage.eligible).length,
      refused: stages.filter((stage) => !stage.eligible).length,
      eligibleBytes: stages.filter((stage) => stage.eligible).reduce((sum, stage) => sum + stage.bytes, 0)
    },
    stages
  };
}

export function quarantineRestorePreview(inventory) {
  const stages = [...(inventory.entries || [])]
    .map((entry) => ({
      directory: entry.name,
      classification: entry.classification,
      acquisitionId: entry.manifest?.acquisitionId || null,
      originalPath: entry.manifest?.originalPath || null,
      quarantinedAt: entry.manifest?.quarantinedAt || null,
      eligible: entry.classification === "quarantined"
    }))
    .sort((left, right) => left.directory.localeCompare(right.directory));
  return {
    generatedAt: new Date().toISOString(),
    inventoryToken: createHash("sha256").update(JSON.stringify(stages)).digest("hex"),
    totals: {
      stages: stages.length,
      eligible: stages.filter((stage) => stage.eligible).length,
      refused: stages.filter((stage) => !stage.eligible).length
    },
    stages
  };
}

export function createOperatorCapabilityStore({ now = () => Date.now(), random = () => randomBytes(32).toString("hex") } = {}) {
  const capabilities = new Map();
  return {
    issue({ operation, directory, inventoryToken, ttlMs = 60_000 }) {
      if (!operation || !directory || !inventoryToken || !Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new Error("A bounded operation, directory, inventory token, and TTL are required.");
      }
      const token = random();
      capabilities.set(token, { operation, directory, inventoryToken, expiresAt: now() + ttlMs, used: false });
      return { token, expiresAt: new Date(capabilities.get(token).expiresAt).toISOString() };
    },
    consume(token, expected) {
      const capability = capabilities.get(token);
      if (!capability) throw new Error("Unknown operator capability.");
      if (capability.used) throw new Error("Operator capability has already been used.");
      if (now() >= capability.expiresAt) throw new Error("Operator capability has expired.");
      if (capability.operation !== expected.operation
        || capability.directory !== expected.directory
        || capability.inventoryToken !== expected.inventoryToken) {
        throw new Error("Operator capability does not match this operation.");
      }
      capability.used = true;
    }
  };
}

export function createRestoreCoordinator({ readInventory, capabilityStore, restore = restoreQuarantinedStage }) {
  let tail = Promise.resolve();
  async function run(request) {
    if (!request || typeof request.inventoryToken !== "string" || typeof request.directory !== "string") {
      throw new Error("A directory and current inventory token are required.");
    }
    capabilityStore.consume(request.capability, {
      operation: "restore", directory: request.directory, inventoryToken: request.inventoryToken
    });
    const inventory = await readInventory();
    const preview = quarantineRestorePreview(inventory);
    if (preview.inventoryToken !== request.inventoryToken) {
      throw new Error("Quarantine inventory changed; refresh the preview before restoring.");
    }
    const entry = inventory.entries.find((candidate) => candidate.name === request.directory);
    if (!entry || entry.classification !== "quarantined") {
      throw new Error(`Quarantined directory is not eligible: ${request.directory}`);
    }
    await restore({ source: entry.path, destination: entry.manifest.originalPath });
    return { inventoryToken: preview.inventoryToken, restored: request.directory };
  }
  return {
    restore(request) {
      const result = tail.then(() => run(request));
      tail = result.catch(() => undefined);
      return result;
    }
  };
}

export function createQuarantineCoordinator({ readInventory, pathsForStage, capabilityStore, quarantine = quarantineStage }) {
  if (!capabilityStore || typeof capabilityStore.consume !== "function") {
    throw new Error("An operator capability store is required.");
  }
  let tail = Promise.resolve();

  async function run(request) {
    if (!request || typeof request.inventoryToken !== "string") {
      throw new Error("A current inventory token is required.");
    }
    const requestedDirectories = request.directories || [];
    if (requestedDirectories.length !== 1) throw new Error("Exactly one staging directory is required per quarantine operation.");
    const directories = [...new Set(requestedDirectories)];
    capabilityStore.consume(request.capability, {
      operation: "quarantine", directory: directories[0], inventoryToken: request.inventoryToken
    });
    const preview = quarantinePreview(await readInventory());
    if (preview.inventoryToken !== request.inventoryToken) {
      throw new Error("Staging inventory changed; refresh the preview before quarantining.");
    }
    const stages = new Map(preview.stages.map((stage) => [stage.directory, stage]));
    const selected = directories.map((directory) => {
      const stage = stages.get(directory);
      if (!stage) throw new Error(`Unknown staging directory: ${directory}`);
      if (!stage.eligible) throw new Error(`Staging directory is not eligible: ${directory}`);
      return stage;
    });

    const moved = [];
    for (const stage of selected) {
      const paths = pathsForStage(stage);
      await quarantine({ stage, source: paths.source, destination: paths.destination });
      moved.push(stage.directory);
    }
    return { inventoryToken: preview.inventoryToken, moved };
  }

  return {
    quarantine(request) {
      const result = tail.then(() => run(request));
      tail = result.catch(() => undefined);
      return result;
    }
  };
}

function assertQuarantineEligible(stage) {
  if (!recoverableClassifications.has(stage.classification)) {
    throw new Error("Only owned or legacy-correlated staging can be quarantined.");
  }
  if (!terminalStatuses.has(stage.acquisitionStatus)) {
    throw new Error("Only terminal failed or cancelled staging can be quarantined.");
  }
}

export async function quarantineStage({
  stage,
  source,
  destination,
  move = rename,
  writeIntent = writeFile,
  writeManifest = writeFile,
  now = () => new Date()
}) {
  assertQuarantineEligible(stage);
  if (!existsSync(source)) throw new Error("Staging directory no longer exists.");
  if (existsSync(destination)) throw new Error("Quarantine destination already exists.");
  await mkdir(dirname(destination), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    quarantinedAt: now().toISOString(),
    originalPath: resolve(source),
    acquisitionId: stage.acquisitionId || null,
    acquisitionStatus: stage.acquisitionStatus,
    classification: stage.classification
  };
  const intentPath = `${destination}${quarantineIntentSuffix}`;
  const intent = { ...manifest, destinationPath: resolve(destination) };
  await writeIntent(intentPath, `${JSON.stringify(intent, null, 2)}\n`, { flag: "wx" });
  try {
    await move(source, destination);
  } catch (error) {
    await rm(intentPath, { force: true });
    throw error;
  }
  try {
    await writeManifest(join(destination, quarantineManifestName), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    try {
      await move(destination, source);
      await rm(intentPath, { force: true });
    } catch (rollbackError) {
      error.cause = rollbackError;
    }
    throw error;
  }
  await rm(intentPath, { force: true });
  return manifest;
}

export async function reconcileQuarantineIntents(root, { writeManifest = writeFile } = {}) {
  if (!existsSync(root)) return { finalised: [], stale: [], invalid: [] };
  const result = { finalised: [], stale: [], invalid: [] };
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (!item.isFile() || !item.name.endsWith(quarantineIntentSuffix)) continue;
    const intentPath = join(root, item.name);
    try {
      const intent = JSON.parse(await readFile(intentPath, "utf8"));
      const destination = intentPath.slice(0, -quarantineIntentSuffix.length);
      const valid = intent.schemaVersion === 1
        && resolve(intent.destinationPath) === resolve(destination)
        && typeof intent.originalPath === "string"
        && recoverableClassifications.has(intent.classification)
        && terminalStatuses.has(intent.acquisitionStatus);
      if (!valid) throw new Error("Invalid quarantine intent.");
      if (existsSync(intent.originalPath) && !existsSync(destination)) {
        await rm(intentPath);
        result.stale.push(basename(destination));
        continue;
      }
      if (existsSync(intent.originalPath) || !existsSync(destination)) {
        throw new Error("Quarantine intent paths are ambiguous.");
      }
      const manifest = {
        schemaVersion: intent.schemaVersion,
        quarantinedAt: intent.quarantinedAt,
        originalPath: intent.originalPath,
        acquisitionId: intent.acquisitionId || null,
        acquisitionStatus: intent.acquisitionStatus,
        classification: intent.classification
      };
      const manifestPath = join(destination, quarantineManifestName);
      if (existsSync(manifestPath)) {
        const existingManifest = JSON.parse(await readFile(manifestPath, "utf8"));
        const matchesIntent = Object.keys(manifest).every((key) => existingManifest[key] === manifest[key]);
        if (!matchesIntent) throw new Error("Existing quarantine manifest does not match intent.");
      } else {
        await writeManifest(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      }
      await rm(intentPath);
      result.finalised.push(basename(destination));
    } catch (error) {
      result.invalid.push({ intent: item.name, error: error.message });
    }
  }
  return result;
}

export async function restoreQuarantinedStage({
  source,
  destination,
  move = rename,
  writeIntent = writeFile,
  removeMarker = rm
}) {
  if (!existsSync(source)) throw new Error("Quarantined staging directory no longer exists.");
  if (existsSync(destination)) throw new Error("Staging restore destination already exists.");
  const manifestPath = join(source, quarantineManifestName);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (resolve(destination) !== resolve(manifest.originalPath)) {
    throw new Error("Restore destination does not match the quarantine manifest.");
  }
  await mkdir(dirname(destination), { recursive: true });
  const intentPath = `${source}${restoreIntentSuffix}`;
  const intent = {
    schemaVersion: 1,
    sourcePath: resolve(source),
    destinationPath: resolve(destination),
    manifest
  };
  await writeIntent(intentPath, `${JSON.stringify(intent, null, 2)}\n`, { flag: "wx" });
  try {
    await move(source, destination);
  } catch (error) {
    await rm(intentPath, { force: true });
    throw error;
  }
  await removeMarker(join(destination, quarantineManifestName));
  await rm(intentPath, { force: true });
}

export async function reconcileRestoreIntents(root, { removeMarker = rm } = {}) {
  if (!existsSync(root)) return { finalised: [], stale: [], invalid: [] };
  const result = { finalised: [], stale: [], invalid: [] };
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (!item.isFile() || !item.name.endsWith(restoreIntentSuffix)) continue;
    const intentPath = join(root, item.name);
    try {
      const intent = JSON.parse(await readFile(intentPath, "utf8"));
      const source = intentPath.slice(0, -restoreIntentSuffix.length);
      const manifest = intent.manifest;
      const valid = intent.schemaVersion === 1
        && resolve(intent.sourcePath) === resolve(source)
        && typeof intent.destinationPath === "string"
        && manifest?.schemaVersion === 1
        && resolve(manifest.originalPath) === resolve(intent.destinationPath)
        && recoverableClassifications.has(manifest.classification)
        && terminalStatuses.has(manifest.acquisitionStatus);
      if (!valid) throw new Error("Invalid restore intent.");
      if (existsSync(source) && !existsSync(intent.destinationPath)) {
        await rm(intentPath);
        result.stale.push(basename(source));
        continue;
      }
      if (existsSync(source) || !existsSync(intent.destinationPath)) {
        throw new Error("Restore intent paths are ambiguous.");
      }
      const restoredMarkerPath = join(intent.destinationPath, quarantineManifestName);
      const restoredManifest = JSON.parse(await readFile(restoredMarkerPath, "utf8"));
      const matchesIntent = Object.keys(manifest).every((key) => restoredManifest[key] === manifest[key]);
      if (!matchesIntent) throw new Error("Restored quarantine marker does not match intent.");
      await removeMarker(restoredMarkerPath);
      await rm(intentPath);
      result.finalised.push(basename(source));
    } catch (error) {
      result.invalid.push({ intent: item.name, error: error.message });
    }
  }
  return result;
}

export async function quarantineInventory(root) {
  if (!existsSync(root)) return { root: resolve(root), entries: [], totals: { entries: 0, valid: 0, invalid: 0 } };
  const entries = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const path = join(root, item.name);
    try {
      const manifest = JSON.parse(await readFile(join(path, quarantineManifestName), "utf8"));
      const valid = manifest.schemaVersion === 1 && typeof manifest.originalPath === "string"
        && recoverableClassifications.has(manifest.classification)
        && terminalStatuses.has(manifest.acquisitionStatus);
      entries.push({ name: basename(path), path, classification: valid ? "quarantined" : "invalid_manifest", manifest });
    } catch (error) {
      entries.push({ name: basename(path), path, classification: "invalid_manifest", error: error.message });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const valid = entries.filter((entry) => entry.classification === "quarantined").length;
  return { root: resolve(root), entries, totals: { entries: entries.length, valid, invalid: entries.length - valid } };
}
