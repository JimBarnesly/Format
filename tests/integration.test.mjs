import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { publishAlbumDirectory } from "../album-publisher.mjs";
import { createOperatorCapabilityStore, createQuarantineCoordinator, createRestoreCoordinator, quarantineIntentSuffix, quarantineInventory, quarantineManifestName, quarantinePreview, quarantineRestorePreview, quarantineStage, reconcileQuarantineIntents, reconcileRestoreIntents, restoreIntentSuffix, restoreQuarantinedStage } from "../staging-quarantine.mjs";
import { createOperatorContract, operatorConfirmation } from "../operator-contract.mjs";
import { authenticateOperatorTransport } from "../operator-transport.mjs";
import { createOperatorHandler, startOperatorServer } from "../operator-server.mjs";
import { readOperatorCredential } from "../operator-credential.mjs";
import { startOperatorRuntime } from "../operator-runtime.mjs";
import { readOperatorTokenFromFd, runOperatorClient } from "../operator-client.mjs";
import { selectOriginalReleaseGroup } from "../release-metadata.mjs";

const execFileAsync = promisify(execFile);
let temporary;
let musicRoot;
let baseUrl;
let serverProcess;

test("selects the original studio album over later exact-title compilations", () => {
  const artistCredit = [{ artist: { name: "Iron Maiden" } }];
  const selected = selectOriginalReleaseGroup([
    { title: "Iron Maiden", "first-release-date": "2004", "primary-type": "Album", "secondary-types": ["Compilation"], "artist-credit": artistCredit, score: 100 },
    { title: "Iron Maiden", "first-release-date": "1998", "primary-type": "Album", "secondary-types": ["Compilation"], "artist-credit": artistCredit, score: 100 },
    { title: "Iron Maiden", "first-release-date": "1980-04-14", "primary-type": "Album", "secondary-types": [], "artist-credit": artistCredit, score: 100 }
  ], { artist: "Iron Maiden", title: "Iron Maiden" });
  assert.equal(selected["first-release-date"], "1980-04-14");
});

test("operator CLI reads its secret only from an inherited descriptor and requires exact confirmation", async () => {
  const token = "client-token-0123456789abcdef0123456789";
  assert.equal(await readOperatorTokenFromFd({
    env: { SIGNAL_OPERATOR_TOKEN_FD: "7" },
    read: async (fd, encoding) => {
      assert.equal(fd, 7);
      assert.equal(encoding, "utf8");
      return `${token}\n`;
    }
  }), token);
  await assert.rejects(readOperatorTokenFromFd({ env: { SIGNAL_OPERATOR_TOKEN_FD: "2" } }), /3 or greater/);

  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    const response = calls.length === 1 ? { token: "one-time-capability" } : { moved: true };
    return { ok: true, json: async () => response };
  };
  const inventoryToken = "inventory-generation";
  const confirmation = operatorConfirmation({ operation: "quarantine", directory: "stage-a", inventoryToken });
  const result = await runOperatorClient({
    argv: ["apply", "quarantine", "stage-a", inventoryToken, confirmation],
    env: { OPERATOR_HOST: "127.0.0.1", OPERATOR_PORT: "4535" },
    readToken: async () => token,
    request
  });
  assert.deepEqual(result, { moved: true });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/operator\/capabilities$/);
  assert.match(calls[1].url, /\/operator\/quarantine$/);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${token}`);
  assert.equal(JSON.parse(calls[1].options.body).capability, "one-time-capability");
  await assert.rejects(runOperatorClient({
    argv: ["apply", "quarantine", "stage-a", inventoryToken, "wrong"],
    readToken: async () => token,
    request
  }), /Exact dry-run confirmation/);
});

test("operator credential loading fails closed and reads only a strong systemd credential", async () => {
  const credentialsDirectory = await mkdtemp(join(tmpdir(), "signal-credentials-"));
  try {
    await assert.rejects(readOperatorCredential({ credentialsDirectory }), /ENOENT/);
    await writeFile(join(credentialsDirectory, "signal-operator-token"), "too-short\n", { mode: 0o400 });
    await assert.rejects(readOperatorCredential({ credentialsDirectory }), /at least 32/);
    const expected = "0123456789abcdef0123456789abcdef";
    await chmod(join(credentialsDirectory, "signal-operator-token"), 0o600);
    await writeFile(join(credentialsDirectory, "signal-operator-token"), `${expected}\n`, { mode: 0o400 });
    assert.equal(await readOperatorCredential({ credentialsDirectory }), expected);
    await assert.rejects(
      readOperatorCredential({ credentialsDirectory: "relative/path" }),
      /absolute systemd credentials directory/
    );
    await assert.rejects(
      readOperatorCredential({ credentialsDirectory, credentialName: "../token" }),
      /name is invalid/
    );
  } finally {
    await rm(credentialsDirectory, { recursive: true, force: true });
  }
});

test("production operator runtime composes authoritative read-only state and fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "signal-operator-runtime-"));
  const dataRoot = join(root, "data");
  const stagingRoot = join(dataRoot, "download-staging");
  const quarantineRoot = join(dataRoot, "download-quarantine");
  const credentialsDirectory = join(root, "credentials");
  const token = "runtime-token-0123456789abcdef0123456789";
  await mkdir(credentialsDirectory, { recursive: true });
  await writeFile(join(credentialsDirectory, "signal-operator-token"), token);
  await mkdir(join(stagingRoot, createHash("sha256").update("failed-acquisition").digest("hex")), { recursive: true });
  await writeFile(join(dataRoot, "acquisitions.json"), JSON.stringify({ items: [
    { id: "failed-acquisition", status: "failed" }
  ] }));
  const runtimeEnv = {
    DATA_DIR: dataRoot,
    DOWNLOAD_STAGING_ROOT: stagingRoot,
    QUARANTINE_ROOT: quarantineRoot,
    CREDENTIALS_DIRECTORY: credentialsDirectory,
    OPERATOR_HOST: "127.0.0.1",
    OPERATOR_PORT: "0",
    OPERATOR_MUTATIONS_ENABLED: "false"
  };
  const runtime = await startOperatorRuntime({ env: runtimeEnv });
  try {
    const url = `http://127.0.0.1:${runtime.address().port}`;
    const headers = { authorization: `Bearer ${token}` };
    const previewResponse = await fetch(`${url}/operator/quarantine-preview`, { headers });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.totals.stages, 1);
    assert.equal(preview.totals.eligible, 1);
    const disabled = await fetch(`${url}/operator/capabilities`, { method: "POST", headers });
    assert.equal(disabled.status, 503);
  } finally {
    await new Promise((resolve) => runtime.close(resolve));
  }

  await assert.rejects(startOperatorRuntime({
    env: { ...runtimeEnv, CREDENTIALS_DIRECTORY: join(root, "missing-credentials") }
  }), /ENOENT/);
  await assert.rejects(startOperatorRuntime({
    env: { ...runtimeEnv, DOWNLOAD_STAGING_ROOT: "relative-staging" }
  }), /DOWNLOAD_STAGING_ROOT must be an absolute path/);

  await mkdir(quarantineRoot, { recursive: true });
  await writeFile(join(quarantineRoot, `ambiguous${quarantineIntentSuffix}`), "{}\n");
  await assert.rejects(startOperatorRuntime({ env: runtimeEnv }), /manual review/);
});

test("operator transport requires loopback identity, a strong bearer token, and an allowed browser origin", () => {
  const expectedToken = "0123456789abcdef0123456789abcdef";
  const valid = {
    remoteAddress: "127.0.0.1",
    authorization: `Bearer ${expectedToken}`,
    expectedToken,
    allowedOrigin: "http://127.0.0.1:4535"
  };

  assert.deepEqual(authenticateOperatorTransport(valid), {
    authenticated: true,
    principal: "loopback-operator"
  });
  assert.deepEqual(authenticateOperatorTransport({ ...valid, remoteAddress: "::1" }), {
    authenticated: true,
    principal: "loopback-operator"
  });
  assert.throws(
    () => authenticateOperatorTransport({ ...valid, remoteAddress: "192.168.68.20" }),
    Object.assign(/restricted to loopback/, { status: 403 })
  );
  assert.throws(
    () => authenticateOperatorTransport({ ...valid, authorization: "Bearer wrong" }),
    /authentication failed/
  );
  assert.throws(
    () => authenticateOperatorTransport({ ...valid, origin: "http://192.168.68.60:4534" }),
    /origin is not allowed/
  );
  assert.throws(
    () => authenticateOperatorTransport({ ...valid, expectedToken: "short" }),
    /strong operator token/
  );
});

test("separate operator server authenticates previews and starts only after recovery", async () => {
  const expectedToken = "0123456789abcdef0123456789abcdef";
  const events = [];
  const handler = createOperatorHandler({
    expectedToken,
    allowedOrigin: "http://127.0.0.1:4535",
    readStagingInventory: async () => ({ stages: [] }),
    readQuarantineInventory: async () => ({ entries: [] }),
    mutationsEnabled: false
  });
  const operatorServer = await startOperatorServer({
    handler,
    reconcileQuarantine: async () => {
      events.push("quarantine-recovery");
      return { finalised: [], stale: [], invalid: [] };
    },
    reconcileRestore: async () => {
      events.push("restore-recovery");
      return { finalised: [], stale: [], invalid: [] };
    }
  });
  try {
    assert.deepEqual(events, ["quarantine-recovery", "restore-recovery"]);
    const operatorUrl = `http://127.0.0.1:${operatorServer.address().port}`;
    const unauthenticated = await fetch(`${operatorUrl}/operator/quarantine-preview`);
    assert.equal(unauthenticated.status, 401);
    const preview = await fetch(`${operatorUrl}/operator/quarantine-preview`, {
      headers: { authorization: `Bearer ${expectedToken}` }
    });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).totals.stages, 0);
    const disabled = await fetch(`${operatorUrl}/operator/capabilities`, {
      method: "POST",
      headers: { authorization: `Bearer ${expectedToken}`, "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(disabled.status, 503);
  } finally {
    await new Promise((resolve) => operatorServer.close(resolve));
  }
  await assert.rejects(startOperatorServer({
    handler,
    host: "0.0.0.0",
    reconcileQuarantine: async () => ({ finalised: [], stale: [], invalid: [] }),
    reconcileRestore: async () => ({ finalised: [], stale: [], invalid: [] })
  }), /must bind to loopback/);
});

test("operator server refuses to listen when recovery needs manual review", async () => {
  const events = [];
  await assert.rejects(startOperatorServer({
    handler: () => {},
    reconcileQuarantine: async () => {
      events.push("quarantine-recovery");
      return { finalised: [], stale: [], invalid: [{ intent: "stage-a.intent", error: "paths are ambiguous" }] };
    },
    reconcileRestore: async () => {
      events.push("restore-recovery");
      return { finalised: [], stale: [], invalid: [] };
    }
  }), /manual review: quarantine: stage-a\.intent: paths are ambiguous/);
  assert.deepEqual(events, ["quarantine-recovery", "restore-recovery"]);

  await assert.rejects(startOperatorServer({
    handler: () => {},
    reconcileQuarantine: async () => ({ finalised: [], stale: [], invalid: [] }),
    reconcileRestore: async () => undefined
  }), /restore recovery returned an invalid report/);
});

test("operator server composes exact confirmation, one-time capability, and quarantine coordinator", async () => {
  const expectedToken = "abcdef0123456789abcdef0123456789";
  const inventory = { stages: [
    { directory: "stage-a", classification: "owned", acquisitionId: "acq-a", acquisitionStatus: "failed", bytes: 12, files: 1 }
  ] };
  const inventoryToken = quarantinePreview(inventory).inventoryToken;
  const capabilityStore = createOperatorCapabilityStore({ random: () => "one-time-capability" });
  const moved = [];
  const quarantineCoordinator = createQuarantineCoordinator({
    readInventory: async () => inventory,
    capabilityStore,
    pathsForStage: (stage) => ({ source: `/staging/${stage.directory}`, destination: `/quarantine/${stage.directory}` }),
    quarantine: async ({ stage }) => moved.push(stage.directory)
  });
  const handler = createOperatorHandler({
    expectedToken,
    readStagingInventory: async () => inventory,
    readQuarantineInventory: async () => ({ entries: [] }),
    contract: createOperatorContract({ capabilityStore }),
    quarantineCoordinator,
    restoreCoordinator: { restore: async () => { throw new Error("not used"); } },
    mutationsEnabled: true
  });
  const operatorServer = await startOperatorServer({
    handler,
    reconcileQuarantine: async () => ({ finalised: [], stale: [], invalid: [] }),
    reconcileRestore: async () => ({ finalised: [], stale: [], invalid: [] })
  });
  try {
    const url = `http://127.0.0.1:${operatorServer.address().port}`;
    const headers = { authorization: `Bearer ${expectedToken}`, "content-type": "application/json" };
    const capabilityResponse = await fetch(`${url}/operator/capabilities`, {
      method: "POST", headers,
      body: JSON.stringify({
        operation: "quarantine", directory: "stage-a", inventoryToken,
        confirmation: operatorConfirmation({ operation: "quarantine", directory: "stage-a", inventoryToken })
      })
    });
    assert.equal(capabilityResponse.status, 201);
    const issued = await capabilityResponse.json();
    const request = { capability: issued.token, directory: "stage-a", inventoryToken };
    const movedResponse = await fetch(`${url}/operator/quarantine`, {
      method: "POST", headers, body: JSON.stringify(request)
    });
    assert.equal(movedResponse.status, 200);
    assert.deepEqual(moved, ["stage-a"]);
    const replay = await fetch(`${url}/operator/quarantine`, {
      method: "POST", headers, body: JSON.stringify(request)
    });
    assert.equal(replay.status, 409);
    assert.match((await replay.json()).error, /already been used/);
  } finally {
    await new Promise((resolve) => operatorServer.close(resolve));
  }
});

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

test("album publication retains stage and destination state when rename fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "signal-publish-failure-"));
  const stage = join(root, "stage");
  const source = join(stage, "Artist", "Album");
  const destination = join(root, "library", "Artist", "Album");
  const stagedTrack = join(source, "01.flac");
  await mkdir(source, { recursive: true });
  await writeFile(stagedTrack, "staged-audio");

  await assert.rejects(
    publishAlbumDirectory({
      source,
      destination,
      stage,
      move: async () => { throw Object.assign(new Error("simulated rename failure"), { code: "EXDEV" }); }
    }),
    /simulated rename failure/
  );

  assert.equal(await readFile(stagedTrack, "utf8"), "staged-audio");
  await assert.rejects(access(destination), { code: "ENOENT" });
});

test("staging quarantine is recoverable and refuses unsafe classifications or active work", async () => {
  const root = await mkdtemp(join(tmpdir(), "signal-quarantine-"));
  const staging = join(root, "staging", "owned-stage");
  const quarantined = join(root, "quarantine", "owned-stage");
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, "album.flac"), "recoverable-audio");

  for (const unsafe of [
    { classification: "orphaned", acquisitionStatus: "failed" },
    { classification: "invalid_marker", acquisitionStatus: "failed" },
    { classification: "owned", acquisitionStatus: "running" }
  ]) {
    await assert.rejects(quarantineStage({ stage: unsafe, source: staging, destination: quarantined }), /Only/);
  }
  assert.equal(await readFile(join(staging, "album.flac"), "utf8"), "recoverable-audio");

  await quarantineStage({
    stage: { acquisitionId: "acq-1", classification: "owned", acquisitionStatus: "failed" },
    source: staging,
    destination: quarantined,
    now: () => new Date("2026-08-03T01:00:00.000Z")
  });
  await assert.rejects(access(staging), { code: "ENOENT" });
  assert.equal(await readFile(join(quarantined, "album.flac"), "utf8"), "recoverable-audio");
  const manifest = JSON.parse(await readFile(join(quarantined, quarantineManifestName), "utf8"));
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    quarantinedAt: "2026-08-03T01:00:00.000Z",
    originalPath: staging,
    acquisitionId: "acq-1",
    acquisitionStatus: "failed",
    classification: "owned"
  });
  const inventory = await quarantineInventory(join(root, "quarantine"));
  assert.deepEqual(inventory.totals, { entries: 1, valid: 1, invalid: 0 });
  assert.equal(inventory.entries[0].manifest.acquisitionId, "acq-1");

  await restoreQuarantinedStage({ source: quarantined, destination: staging });
  await assert.rejects(access(quarantined), { code: "ENOENT" });
  assert.equal(await readFile(join(staging, "album.flac"), "utf8"), "recoverable-audio");
  await assert.rejects(access(join(staging, quarantineManifestName)), { code: "ENOENT" });
});

test("staging quarantine and restore rename failures preserve their source trees", async () => {
  const root = await mkdtemp(join(tmpdir(), "signal-quarantine-failure-"));
  const staging = join(root, "staging", "owned-stage");
  const quarantined = join(root, "quarantine", "owned-stage");
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, "album.flac"), "recoverable-audio");
  const failMove = async () => { throw Object.assign(new Error("simulated rename failure"), { code: "EXDEV" }); };

  await assert.rejects(quarantineStage({
    stage: { acquisitionId: "acq-2", classification: "owned", acquisitionStatus: "failed" },
    source: staging,
    destination: quarantined,
    move: failMove
  }), /simulated rename failure/);
  assert.equal(await readFile(join(staging, "album.flac"), "utf8"), "recoverable-audio");
  await assert.rejects(access(quarantined), { code: "ENOENT" });

  await quarantineStage({
    stage: { acquisitionId: "acq-2", classification: "owned", acquisitionStatus: "failed" },
    source: staging,
    destination: quarantined
  });
  await assert.rejects(restoreQuarantinedStage({ source: quarantined, destination: staging, move: failMove }), /simulated rename failure/);
  assert.equal(await readFile(join(quarantined, "album.flac"), "utf8"), "recoverable-audio");
  await assert.rejects(access(staging), { code: "ENOENT" });
});

test("staging quarantine rolls back manifest failures and refuses path collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "signal-quarantine-rollback-"));
  const staging = join(root, "staging", "owned-stage");
  const quarantined = join(root, "quarantine", "owned-stage");
  const occupied = join(root, "quarantine", "occupied-stage");
  const stage = { acquisitionId: "acq-3", classification: "owned", acquisitionStatus: "failed" };
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, "album.flac"), "recoverable-audio");

  await assert.rejects(quarantineStage({
    stage,
    source: staging,
    destination: quarantined,
    writeManifest: async () => { throw new Error("simulated manifest failure"); }
  }), /simulated manifest failure/);
  assert.equal(await readFile(join(staging, "album.flac"), "utf8"), "recoverable-audio");
  await assert.rejects(access(quarantined), { code: "ENOENT" });

  await mkdir(occupied, { recursive: true });
  await writeFile(join(occupied, "sentinel"), "do-not-replace");
  await assert.rejects(quarantineStage({ stage, source: staging, destination: occupied }), /already exists/);
  assert.equal(await readFile(join(staging, "album.flac"), "utf8"), "recoverable-audio");
  assert.equal(await readFile(join(occupied, "sentinel"), "utf8"), "do-not-replace");

  await quarantineStage({ stage, source: staging, destination: quarantined });
  const wrongRestore = join(root, "staging", "wrong-stage");
  await assert.rejects(
    restoreQuarantinedStage({ source: quarantined, destination: wrongRestore }),
    /does not match/
  );
  assert.equal(await readFile(join(quarantined, "album.flac"), "utf8"), "recoverable-audio");

  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, "sentinel"), "do-not-replace");
  await assert.rejects(restoreQuarantinedStage({ source: quarantined, destination: staging }), /already exists/);
  assert.equal(await readFile(join(staging, "sentinel"), "utf8"), "do-not-replace");
  assert.equal(await readFile(join(quarantined, "album.flac"), "utf8"), "recoverable-audio");
});

test("quarantine restart reconciliation finalises moved stages and clears pre-move intents", async () => {
  const root = await mkdtemp(join(tmpdir(), "signal-quarantine-restart-"));
  const staging = join(root, "staging", "owned-stage");
  const quarantineRoot = join(root, "quarantine");
  const quarantined = join(quarantineRoot, "owned-stage");
  const intentPath = `${quarantined}${quarantineIntentSuffix}`;
  const stage = { acquisitionId: "acq-restart", classification: "owned", acquisitionStatus: "failed" };
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, "album.flac"), "recoverable-audio");

  await assert.rejects(quarantineStage({
    stage, source: staging, destination: quarantined,
    move: async () => { throw new Error("pre-move crash simulation"); }
  }), /pre-move crash/);
  await assert.rejects(access(intentPath), { code: "ENOENT" });
  assert.equal(await readFile(join(staging, "album.flac"), "utf8"), "recoverable-audio");

  const now = () => new Date("2026-08-03T06:00:00.000Z");
  await assert.rejects(quarantineStage({
    stage, source: staging, destination: quarantined, now,
    writeManifest: async () => { throw new Error("simulated process termination"); },
    move: async (source, destination) => {
      const { rename } = await import("node:fs/promises");
      await rename(source, destination);
      throw Object.assign(new Error("leave moved tree and intent"), { cause: new Error("rollback interrupted") });
    }
  }), /leave moved tree|simulated process termination/);

  // Recreate the exact post-rename crash state because the normal error path attempts rollback.
  if (!await access(quarantined).then(() => true, () => false)) {
    const { rename } = await import("node:fs/promises");
    await rename(staging, quarantined);
  }
  const intent = {
    schemaVersion: 1, quarantinedAt: now().toISOString(), originalPath: staging,
    acquisitionId: stage.acquisitionId, acquisitionStatus: stage.acquisitionStatus,
    classification: stage.classification, destinationPath: quarantined
  };
  await writeFile(intentPath, `${JSON.stringify(intent)}\n`, { flag: "w" });
  const recovered = await reconcileQuarantineIntents(quarantineRoot);
  assert.deepEqual(recovered, { finalised: ["owned-stage"], stale: [], invalid: [] });
  await assert.rejects(access(intentPath), { code: "ENOENT" });
  assert.equal(await readFile(join(quarantined, "album.flac"), "utf8"), "recoverable-audio");
  const manifest = JSON.parse(await readFile(join(quarantined, quarantineManifestName), "utf8"));
  assert.equal(manifest.originalPath, staging);
  assert.equal(manifest.acquisitionId, "acq-restart");

  const staleDestination = join(quarantineRoot, "stale-stage");
  const staleIntentPath = `${staleDestination}${quarantineIntentSuffix}`;
  await writeFile(staleIntentPath, `${JSON.stringify({ ...intent, originalPath: staging, destinationPath: staleDestination })}\n`);
  await mkdir(staging, { recursive: true });
  const stale = await reconcileQuarantineIntents(quarantineRoot);
  assert.deepEqual(stale, { finalised: [], stale: ["stale-stage"], invalid: [] });
  await assert.rejects(access(staleIntentPath), { code: "ENOENT" });
});

test("quarantine restart reconciliation retains intents on manifest conflicts or write failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "signal-quarantine-reconcile-failure-"));
  const quarantineRoot = join(root, "quarantine");
  const originalPath = join(root, "staging", "owned-stage");
  const destination = join(quarantineRoot, "owned-stage");
  const intentPath = `${destination}${quarantineIntentSuffix}`;
  const intent = {
    schemaVersion: 1,
    quarantinedAt: "2026-08-03T06:30:00.000Z",
    originalPath,
    acquisitionId: "acq-reconcile",
    acquisitionStatus: "failed",
    classification: "owned",
    destinationPath: destination
  };
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "album.flac"), "recoverable-audio");
  await writeFile(intentPath, `${JSON.stringify(intent)}\n`);
  await writeFile(join(destination, quarantineManifestName), `${JSON.stringify({
    ...intent, acquisitionId: "different-acquisition", destinationPath: undefined
  })}\n`);

  const conflict = await reconcileQuarantineIntents(quarantineRoot);
  assert.equal(conflict.finalised.length, 0);
  assert.match(conflict.invalid[0].error, /does not match intent/);
  assert.equal(await readFile(join(destination, "album.flac"), "utf8"), "recoverable-audio");
  assert.equal(await access(intentPath).then(() => true, () => false), true);

  const manifestPath = join(destination, quarantineManifestName);
  const { unlink } = await import("node:fs/promises");
  await unlink(manifestPath);
  const writeFailure = await reconcileQuarantineIntents(quarantineRoot, {
    writeManifest: async () => { throw new Error("simulated reconciliation write failure"); }
  });
  assert.equal(writeFailure.finalised.length, 0);
  assert.match(writeFailure.invalid[0].error, /simulated reconciliation write failure/);
  assert.equal(await access(intentPath).then(() => true, () => false), true);
  await assert.rejects(access(manifestPath), { code: "ENOENT" });
  assert.equal(await readFile(join(destination, "album.flac"), "utf8"), "recoverable-audio");
});

test("quarantine preview token changes with staging identity or acquisition state", () => {
  const base = { stages: [{
    directory: "stage-a", classification: "owned", acquisitionId: "acq-1",
    acquisitionStatus: "failed", markerPresent: true, markerError: null, bytes: 42, files: 1
  }] };
  const preview = quarantinePreview(base);
  assert.equal(preview.inventoryToken.length, 64);
  assert.deepEqual(preview.totals, { stages: 1, eligible: 1, refused: 0, eligibleBytes: 42 });
  assert.equal(quarantinePreview({ ...base, generatedAt: "later" }).inventoryToken, preview.inventoryToken);
  assert.notEqual(quarantinePreview({ stages: [{ ...base.stages[0], acquisitionStatus: "running" }] }).inventoryToken, preview.inventoryToken);
  assert.notEqual(quarantinePreview({ stages: [{ ...base.stages[0], directory: "stage-b" }] }).inventoryToken, preview.inventoryToken);
  const refused = quarantinePreview({ stages: [{ ...base.stages[0], classification: "orphaned" }] });
  assert.deepEqual(refused.totals, { stages: 1, eligible: 0, refused: 1, eligibleBytes: 0 });
});

test("quarantine coordinator serialises moves and refuses stale or unsafe selections", async () => {
  let inventory = {
    stages: [
      { directory: "eligible-a", classification: "owned", acquisitionId: "a", acquisitionStatus: "failed", bytes: 10, files: 1 },
      { directory: "refused-b", classification: "orphaned", bytes: 20, files: 1 }
    ]
  };
  const initialToken = quarantinePreview(inventory).inventoryToken;
  const events = [];
  let releaseFirst;
  let capabilitySequence = 0;
  const capabilityStore = createOperatorCapabilityStore({ random: () => `quarantine-${++capabilitySequence}` });
  const capability = (directory, inventoryToken) => capabilityStore.issue({
    operation: "quarantine", directory, inventoryToken, ttlMs: 30_000
  }).token;
  const coordinator = createQuarantineCoordinator({
    readInventory: async () => inventory,
    capabilityStore,
    pathsForStage: (stage) => ({ source: `/staging/${stage.directory}`, destination: `/quarantine/${stage.directory}` }),
    quarantine: async ({ stage }) => {
      events.push(`start:${stage.directory}`);
      if (stage.directory === "eligible-a") await new Promise((resolvePromise) => { releaseFirst = resolvePromise; });
      events.push(`end:${stage.directory}`);
    }
  });

  await assert.rejects(
    coordinator.quarantine({ capability: capability("refused-b", initialToken), inventoryToken: initialToken, directories: ["refused-b"] }),
    /not eligible/
  );
  const first = coordinator.quarantine({ capability: capability("eligible-a", initialToken), inventoryToken: initialToken, directories: ["eligible-a"] });
  while (!releaseFirst) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  inventory = { stages: [{ ...inventory.stages[0], acquisitionStatus: "running" }] };
  const second = coordinator.quarantine({ capability: capability("eligible-a", initialToken), inventoryToken: initialToken, directories: ["eligible-a"] });
  assert.deepEqual(events, ["start:eligible-a"]);
  releaseFirst();
  await first;
  await assert.rejects(second, /inventory changed/);
  assert.deepEqual(events, ["start:eligible-a", "end:eligible-a"]);
  await assert.rejects(
    coordinator.quarantine({ capability: "unused", inventoryToken: quarantinePreview(inventory).inventoryToken, directories: ["eligible-a", "eligible-a"] }),
    /Exactly one/
  );
});

test("operator capabilities are expiring, one-time, and bound to one exact operation", () => {
  let clock = Date.parse("2026-08-03T08:00:00.000Z");
  let sequence = 0;
  const store = createOperatorCapabilityStore({ now: () => clock, random: () => `cap-${++sequence}` });
  const first = store.issue({ operation: "restore", directory: "stage-a", inventoryToken: "inventory-a", ttlMs: 1000 });
  assert.equal(first.token, "cap-1");
  assert.throws(() => store.consume(first.token, { operation: "restore", directory: "stage-b", inventoryToken: "inventory-a" }), /does not match/);
  store.consume(first.token, { operation: "restore", directory: "stage-a", inventoryToken: "inventory-a" });
  assert.throws(() => store.consume(first.token, { operation: "restore", directory: "stage-a", inventoryToken: "inventory-a" }), /already been used/);
  const expired = store.issue({ operation: "restore", directory: "stage-a", inventoryToken: "inventory-a", ttlMs: 1000 });
  clock += 1000;
  assert.throws(() => store.consume(expired.token, { operation: "restore", directory: "stage-a", inventoryToken: "inventory-a" }), /expired/);
});

test("operator contract fails closed and requires exact dry-run confirmation", () => {
  let sequence = 0;
  const capabilities = createOperatorCapabilityStore({ random: () => `operator-${++sequence}` });
  const contract = createOperatorContract({ capabilityStore: capabilities, ttlMs: 15_000 });
  const request = {
    operation: "quarantine",
    directory: "owned-stage",
    inventoryToken: "inventory-a"
  };
  request.confirmation = operatorConfirmation(request);

  assert.throws(
    () => contract.issue({ ...request, transport: { authenticated: false, principal: "operator" } }),
    /Authenticated operator transport/
  );
  assert.throws(
    () => contract.issue({ ...request, confirmation: "quarantine:other-stage:inventory-a", transport: { authenticated: true, principal: "operator" } }),
    /Exact dry-run confirmation/
  );
  assert.throws(
    () => contract.issue({ ...request, operation: "delete", transport: { authenticated: true, principal: "operator" } }),
    /valid operation/
  );

  const issued = contract.issue({ ...request, transport: { authenticated: true, principal: "operator" } });
  assert.equal(issued.token, "operator-1");
  assert.equal(issued.principal, "operator");
  capabilities.consume(issued.token, request);
  assert.throws(() => capabilities.consume(issued.token, request), /already been used/);
});

test("operator contract caps short-lived capabilities", () => {
  const capabilities = createOperatorCapabilityStore();
  assert.throws(() => createOperatorContract({ capabilityStore: capabilities, ttlMs: 60_001 }), /between 1 and 60000/);
});

test("restore coordinator serialises work and refuses replay, stale inventory, and invalid stages", async () => {
  let inventory = { entries: [{
    name: "stage-a", path: "/quarantine/stage-a", classification: "quarantined",
    manifest: { acquisitionId: "acq-a", originalPath: "/staging/stage-a", quarantinedAt: "2026-08-03T07:00:00.000Z" }
  }] };
  const token = quarantineRestorePreview(inventory).inventoryToken;
  let sequence = 0;
  const capabilities = createOperatorCapabilityStore({ random: () => `restore-${++sequence}` });
  const events = [];
  let releaseFirst;
  const coordinator = createRestoreCoordinator({
    readInventory: async () => inventory,
    capabilityStore: capabilities,
    restore: async ({ source, destination }) => {
      events.push(`start:${source}:${destination}`);
      await new Promise((resolvePromise) => { releaseFirst = resolvePromise; });
      events.push("end:stage-a");
    }
  });
  const firstCapability = capabilities.issue({ operation: "restore", directory: "stage-a", inventoryToken: token });
  const first = coordinator.restore({ capability: firstCapability.token, directory: "stage-a", inventoryToken: token });
  while (!releaseFirst) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const staleCapability = capabilities.issue({ operation: "restore", directory: "stage-a", inventoryToken: token });
  inventory = { entries: [{ ...inventory.entries[0], classification: "invalid_manifest" }] };
  const second = coordinator.restore({ capability: staleCapability.token, directory: "stage-a", inventoryToken: token });
  assert.deepEqual(events, ["start:/quarantine/stage-a:/staging/stage-a"]);
  releaseFirst();
  await first;
  await assert.rejects(second, /inventory changed/);
  await assert.rejects(
    coordinator.restore({ capability: staleCapability.token, directory: "stage-a", inventoryToken: token }),
    /already been used/
  );
  assert.deepEqual(events, ["start:/quarantine/stage-a:/staging/stage-a", "end:stage-a"]);
});

test("restore restart reconciliation finalises moved stages and clears pre-move intents", async () => {
  const root = await mkdtemp(join(tmpdir(), "signal-restore-restart-"));
  const quarantineRoot = join(root, "quarantine");
  const source = join(quarantineRoot, "owned-stage");
  const destination = join(root, "staging", "owned-stage");
  const intentPath = `${source}${restoreIntentSuffix}`;
  const stage = { classification: "owned", acquisitionId: "acq-restore", acquisitionStatus: "failed" };
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "album.flac"), "recoverable-audio");
  const manifest = {
    schemaVersion: 1, quarantinedAt: "2026-08-03T09:00:00.000Z", originalPath: destination,
    acquisitionId: stage.acquisitionId, acquisitionStatus: stage.acquisitionStatus, classification: stage.classification
  };
  await writeFile(join(source, quarantineManifestName), `${JSON.stringify(manifest)}\n`);

  await assert.rejects(restoreQuarantinedStage({
    source, destination,
    removeMarker: async () => { throw new Error("simulated marker removal failure"); }
  }), /simulated marker removal failure/);
  assert.equal(await readFile(join(destination, "album.flac"), "utf8"), "recoverable-audio");
  assert.equal(await access(intentPath).then(() => true, () => false), true);
  const recovered = await reconcileRestoreIntents(quarantineRoot);
  assert.deepEqual(recovered.finalised, ["owned-stage"]);
  await assert.rejects(access(join(destination, quarantineManifestName)), { code: "ENOENT" });
  await assert.rejects(access(intentPath), { code: "ENOENT" });

  const staleSource = join(quarantineRoot, "stale-stage");
  const staleIntent = `${staleSource}${restoreIntentSuffix}`;
  await mkdir(staleSource, { recursive: true });
  await writeFile(staleIntent, `${JSON.stringify({
    schemaVersion: 1, sourcePath: staleSource, destinationPath: join(root, "staging", "stale-stage"),
    manifest: { ...manifest, originalPath: join(root, "staging", "stale-stage") }
  })}\n`);
  const stale = await reconcileRestoreIntents(quarantineRoot);
  assert.deepEqual(stale.stale, ["stale-stage"]);
  await assert.rejects(access(staleIntent), { code: "ENOENT" });
});

test("restore reconciliation preserves mismatched markers and retryable removal failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "signal-restore-conflict-"));
  const quarantineRoot = join(root, "quarantine");
  const stagingRoot = join(root, "staging");
  await mkdir(quarantineRoot, { recursive: true });

  async function createMovedRestore(name, markerOverrides = {}) {
    const source = join(quarantineRoot, name);
    const destination = join(stagingRoot, name);
    const intentPath = `${source}${restoreIntentSuffix}`;
    const manifest = {
      schemaVersion: 1,
      quarantinedAt: "2026-08-03T09:30:00.000Z",
      originalPath: destination,
      acquisitionId: `acq-${name}`,
      acquisitionStatus: "failed",
      classification: "owned"
    };
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "album.flac"), `audio-${name}`);
    await writeFile(join(destination, quarantineManifestName), `${JSON.stringify({ ...manifest, ...markerOverrides })}\n`);
    await writeFile(intentPath, `${JSON.stringify({
      schemaVersion: 1, sourcePath: source, destinationPath: destination, manifest
    })}\n`);
    return { destination, intentPath };
  }

  const mismatch = await createMovedRestore("mismatch", { acquisitionId: "wrong-acquisition" });
  const mismatchResult = await reconcileRestoreIntents(quarantineRoot);
  assert.match(mismatchResult.invalid[0].error, /does not match intent/);
  assert.equal(await access(mismatch.intentPath).then(() => true, () => false), true);
  assert.equal(await readFile(join(mismatch.destination, "album.flac"), "utf8"), "audio-mismatch");
  assert.equal(await access(join(mismatch.destination, quarantineManifestName)).then(() => true, () => false), true);

  await rm(mismatch.intentPath);
  const retryable = await createMovedRestore("retryable");
  const removalResult = await reconcileRestoreIntents(quarantineRoot, {
    removeMarker: async () => { throw new Error("simulated reconciliation marker removal failure"); }
  });
  assert.match(removalResult.invalid[0].error, /simulated reconciliation marker removal failure/);
  assert.equal(await access(retryable.intentPath).then(() => true, () => false), true);
  assert.equal(await readFile(join(retryable.destination, "album.flac"), "utf8"), "audio-retryable");
  assert.equal(await access(join(retryable.destination, quarantineManifestName)).then(() => true, () => false), true);
});

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
  const collisionFixtures = join(temporary, "collision-fixtures");
  await flac(join(collisionFixtures, "1.flac"), {
    artist: "Collision Artist", album: "Collision Album", title: "Collision Track", year: "2025", track: 1, total: 1
  });
  const mock = join(temporary, "mock-spotiflac.sh");
  await writeFile(mock, `#!/bin/sh\nset -eu\ncase "$1" in\n  *slow-release*) sleep 30; exit 0 ;;\n  *empty-release*) exit 0 ;;\n  *rate-release*) out="$2/Rate Artist/Rate Album/[2025] Rate Album"; mkdir -p "$out"; cp "$RATE_FIXTURES/1.flac" "$out/01. Delayed Track.flac"; exit 0 ;;\n  *flaky-release*) if [ ! -f "$FLAKY_MARKER" ]; then touch "$FLAKY_MARKER"; sleep 5; fi; out="$2/Flaky Artist/Flaky Album/[2025] Flaky Album"; mkdir -p "$out"; cp "$FLAKY_FIXTURES/1.flac" "$out/01. Recovered Track.flac"; exit 0 ;;\n  *similar-release*) out="$2/Similar Artist/Similar Album/[2025] Similar Album"; mkdir -p "$out"; cp "$SIMILAR_FIXTURES/1.flac" "$out/01. Similar Track.flac"; exit 0 ;;\n  *collision-release*) out="$2/Collision Artist/Collision Album/[2025] Collision Album"; mkdir -p "$out"; cp "$COLLISION_FIXTURES/1.flac" "$out/01. Collision Track.flac"; exit 0 ;;\nesac\nout="$2/Test Artist/Test Album/[2024] Test Album"\nmkdir -p "$out"\ncp "$MOCK_FIXTURES/1.flac" "$out/01. Track 1.flac"\ncp "$MOCK_FIXTURES/2.flac" "$out/02. Track 2.flac"\n`, "utf8");
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
      COLLISION_FIXTURES: collisionFixtures,
      FLAKY_MARKER: join(temporary, "flaky-marker"),
      ACQUISITION_STALL_TIMEOUT_MS: "300",
      ACQUISITION_MAX_ATTEMPTS: "2",
      TEST_SIMILAR_RELEASE: JSON.stringify({ id: "similar-release", artist: "Similar Artist", title: "Similar Album", year: "2025" })
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  serverProcess.stderr.on("data", (chunk) => process.stderr.write(chunk));
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

test("groups inconsistent release years without deleting conflicting numbered tracks", async () => {
  const { body } = await json("/api/library");
  const albums = body.albums.filter((album) => album.artist === "Fixture Artist" && album.title === "Fixture Album");
  assert.equal(albums.length, 1);
  assert.equal(albums[0].expectedTracks, 3);
  assert.equal(albums[0].trackIds.length, 4);
  assert.equal(albums[0].incomplete, false);
  assert.deepEqual(albums[0].missingTracks, []);
});

test("applies hash-verified metadata corrections and relocates the track", async () => {
  const shadowAlbums = (await json("/api/shadow-albums")).body;
  const shadow = shadowAlbums.find((item) => item.artist === "Sola Rosa" && item.title === "Get It Together");
  const track = shadow?.manifest.find((item) => item.title === "The Ace of Space");
  assert.ok(track);
  assert.equal(track.position, 1);
  assert.equal(shadow.status, "incomplete");
  assert.equal(shadowAlbums.some((item) => item.manifest.some((entry) => entry.title === "Awish")), false);
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
  const stageHash = createHash("sha256").update("test-release").digest("hex");
  await assert.rejects(readFile(join(temporary, "data", "download-staging", stageHash, ".signal-acquisition.json")), { code: "ENOENT" });
});

test("retains a complete staged album when its destination already exists", async () => {
  const destination = join(musicRoot, "SpotiFLAC", "Collision Artist", "Collision Album", "[2025] Collision Album");
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "existing.txt"), "keep me");
  await json("/api/test/catalogue?id=collision-release&artist=Collision%20Artist&title=Collision%20Album&year=2025", { method: "POST" });
  assert.equal((await json("/api/acquire-album?id=collision-release", { method: "POST" })).response.status, 202);
  const failed = await waitFor(async () => {
    const { body } = await json("/api/acquisitions");
    return body.find((item) => item.id === "collision-release" && item.status === "failed");
  });
  assert.match(failed.message, /destination already exists/);
  assert.equal(await readFile(join(destination, "existing.txt"), "utf8"), "keep me");
  const stageHash = createHash("sha256").update("collision-release").digest("hex");
  const stage = join(temporary, "data", "download-staging", stageHash);
  const marker = JSON.parse(await readFile(join(stage, ".signal-acquisition.json"), "utf8"));
  assert.equal(marker.acquisitionId, "collision-release");
  assert.ok((await readFile(join(stage, "Collision Artist", "Collision Album", "[2025] Collision Album", "01. Collision Track.flac"))).length > 0);
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
  const shadow = (await json("/api/shadow-albums")).body.find((item) => item.artist === "Empty Artist");
  assert.equal(shadow.status, "needs_attention");
  assert.match(shadow.lastError, /without adding any album files/);
  const stageHash = createHash("sha256").update("empty-release").digest("hex");
  const marker = JSON.parse(await readFile(join(temporary, "data", "download-staging", stageHash, ".signal-acquisition.json"), "utf8"));
  assert.equal(marker.acquisitionId, "empty-release");
  assert.equal(marker.artist, "Empty Artist");
  assert.equal(marker.title, "Empty Album");
  assert.equal(marker.attempt, 1);

  const orphan = join(temporary, "data", "download-staging", "unattributed-stage");
  await mkdir(orphan, { recursive: true });
  await writeFile(join(orphan, "retained.bin"), "retained");
  const report = (await json("/api/acquisitions/staging")).body;
  const owned = report.stages.find((item) => item.acquisitionId === "empty-release");
  assert.equal(owned.classification, "owned");
  assert.equal(owned.acquisitionStatus, "failed");
  assert.equal(owned.markerPresent, true);
  const unattributed = report.stages.find((item) => item.directory === "unattributed-stage");
  assert.equal(unattributed.classification, "orphaned");
  assert.equal(unattributed.acquisitionId, null);
  assert.equal(unattributed.bytes, 8);
  assert.ok(report.totals.owned >= 1);
  assert.ok(report.totals.orphaned >= 1);
  const preview = (await json("/api/acquisitions/staging/quarantine-preview")).body;
  assert.equal(preview.inventoryToken.length, 64);
  assert.ok(preview.totals.eligible >= 1);
  assert.equal(preview.stages.find((item) => item.directory === "unattributed-stage").eligible, false);
});

test("rescans new files and reports genuinely missing tracks", async () => {
  const folder = join(musicRoot, "Partial Artist", "Partial Album");
  await flac(join(folder, "01.flac"), { artist: "Partial Artist", album: "Partial Album", title: "One", year: "2025", track: 1, total: 3 });
  await flac(join(folder, "03.flac"), { artist: "Partial Artist", album: "Partial Album", title: "Three", year: "2025", track: 3, total: 3 });
  const { response, body } = await json("/api/rescan", { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(body.albums.some((item) => item.artist === "Partial Artist"), false);
  const shadow = (await json("/api/shadow-albums")).body.find((item) => item.artist === "Partial Artist");
  assert.ok(shadow);
  assert.equal(shadow.status, "incomplete");
  assert.equal(shadow.published, false);
  assert.deepEqual(shadow.missingTracks, ["1:2"]);
  assert.equal((await fetch(`${baseUrl}/api/library/repair-incomplete`, { method: "POST" })).status, 410);
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
  const shadows = (await json("/api/shadow-albums")).body.filter((item) => item.artist === "Cancel Artist");
  assert.equal(shadows.length, 2);
  assert.ok(shadows.every((item) => item.status === "cancelled"));
});

test("rejects unknown acquisition and deletion targets", async () => {
  assert.equal((await fetch(`${baseUrl}/api/acquire-album?id=missing`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/library/trash-track?id=../../etc/passwd`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/library/trash-album?id=missing`, { method: "POST" })).status, 404);
});

test("edits published album and track metadata without dropping the album", async () => {
  const before = (await json("/api/library")).body;
  const album = before.albums.find((item) => item.artist === "Fixture Artist" && item.title === "Fixture Album");
  assert.ok(album);
  const tracks = album.trackIds.map((id) => before.tracks.find((track) => track.id === id));
  const renamedTrack = tracks.find((track) => track.title === "Two");
  const { response, body } = await json(`/api/library/album-metadata?id=${encodeURIComponent(album.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      albumArtist: "Fixture Artist Edited",
      albumTitle: "Fixture Album Edited",
      originalYear: "2019",
      genre: "Test Genre",
      tracks: tracks.map((track) => ({ id: track.id, title: track.id === renamedTrack.id ? "Two Edited" : track.title }))
    })
  });
  assert.equal(response.status, 200);
  assert.ok(body.album);
  assert.equal(body.album.artist, "Fixture Artist Edited");
  assert.equal(body.album.title, "Fixture Album Edited");
  assert.equal(body.album.year, "2019");
  assert.equal(body.album.trackIds.length, tracks.length);
  assert.ok(body.library.tracks.some((track) => track.title === "Two Edited" && track.album === "Fixture Album Edited"));
});
