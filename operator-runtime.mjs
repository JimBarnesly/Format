import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readAcquisitionRecords, readStagingInventory } from "./acquisition-inventory.mjs";
import { createOperatorContract } from "./operator-contract.mjs";
import { readOperatorCredential } from "./operator-credential.mjs";
import { createOperatorHandler, startOperatorServer } from "./operator-server.mjs";
import {
  createOperatorCapabilityStore,
  createQuarantineCoordinator,
  createRestoreCoordinator,
  quarantineInventory,
  reconcileQuarantineIntents,
  reconcileRestoreIntents
} from "./staging-quarantine.mjs";

function absolutePath(value, name) {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return resolve(value);
}

function childPath(root, name) {
  const path = resolve(root, name);
  if (!name || path === root || !path.startsWith(`${root}${sep}`)) {
    throw new Error("Inventory returned an unsafe staging directory.");
  }
  return path;
}

export async function startOperatorRuntime({
  env = process.env,
  readCredential = readOperatorCredential,
  startServer = startOperatorServer
} = {}) {
  const dataRoot = absolutePath(env.DATA_DIR || "/home/jake/.local/share/gateway-music-browser", "DATA_DIR");
  const stagingRoot = absolutePath(env.DOWNLOAD_STAGING_ROOT || join(dataRoot, "download-staging"), "DOWNLOAD_STAGING_ROOT");
  const quarantineRoot = absolutePath(env.QUARANTINE_ROOT || join(dataRoot, "download-quarantine"), "QUARANTINE_ROOT");
  if (stagingRoot === quarantineRoot) throw new Error("Staging and quarantine roots must be different.");
  const acquisitionFile = absolutePath(env.ACQUISITION_FILE || join(dataRoot, "acquisitions.json"), "ACQUISITION_FILE");
  const host = env.OPERATOR_HOST || "127.0.0.1";
  const port = Number(env.OPERATOR_PORT || 4535);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("OPERATOR_PORT is invalid.");
  const expectedToken = await readCredential({ credentialsDirectory: env.CREDENTIALS_DIRECTORY });
  const capabilityStore = createOperatorCapabilityStore();
  const readCurrentStagingInventory = async () => readStagingInventory({
    stagingRoot,
    acquisitions: await readAcquisitionRecords(acquisitionFile)
  });
  const readCurrentQuarantineInventory = async () => quarantineInventory(quarantineRoot);
  const quarantineCoordinator = createQuarantineCoordinator({
    readInventory: readCurrentStagingInventory,
    capabilityStore,
    pathsForStage: (stage) => ({
      source: childPath(stagingRoot, stage.directory),
      destination: childPath(quarantineRoot, stage.directory)
    })
  });
  const restoreCoordinator = createRestoreCoordinator({
    readInventory: readCurrentQuarantineInventory,
    capabilityStore
  });
  const handler = createOperatorHandler({
    expectedToken,
    allowedOrigin: env.OPERATOR_ALLOWED_ORIGIN || `http://${host}:${port}`,
    readStagingInventory: readCurrentStagingInventory,
    readQuarantineInventory: readCurrentQuarantineInventory,
    contract: createOperatorContract({ capabilityStore }),
    quarantineCoordinator,
    restoreCoordinator,
    mutationsEnabled: env.OPERATOR_MUTATIONS_ENABLED === "true"
  });
  return startServer({
    handler,
    host,
    port,
    reconcileQuarantine: () => reconcileQuarantineIntents(quarantineRoot),
    reconcileRestore: () => reconcileRestoreIntents(quarantineRoot)
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startOperatorRuntime().catch((error) => {
    process.stderr.write(`Signal operator failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}
