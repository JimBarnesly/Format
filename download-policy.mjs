import { constants } from "node:fs";
import { access, lstat, readdir, readFile, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const acquisitionMarker = ".format-acquisition.json";
export const minimumDownloadFreeBytes = 1024n * 1024n * 1024n;
const failure = (message, reason = "storage_unavailable") => Object.assign(new Error(message), { status: 503, reason });

// These paths are administrator configuration, never values supplied by an API request.
export function assertDownloadConfiguration(config) {
  const { root, acquisitionRoot, downloadRoot, stagingRoot, filesystemUuid, host } = config;
  if (![root, acquisitionRoot, downloadRoot, stagingRoot].every((value) => typeof value === "string"
    && isAbsolute(value) && resolve(value) === value && !/[\r\n\0]/.test(value))
    || root === parse(root).root || dirname(acquisitionRoot) !== root
    || downloadRoot !== join(acquisitionRoot, "albums")
    || stagingRoot !== join(acquisitionRoot, "staging")
    || typeof filesystemUuid !== "string" || !filesystemUuid
    || !["127.0.0.1", "::1"].includes(host)) {
    throw failure("Download-only mode needs a dedicated directory, HDD UUID and loopback binding.", "unsafe_configuration");
  }
}

export async function assertNoSymlinks(path, { allowMissing = false } = {}) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw failure("Download paths must not contain symbolic links.");
      if (current !== absolute && !info.isDirectory()) throw failure("Download path parent is not a directory.");
    } catch (error) {
      if (allowMissing && error.code === "ENOENT") return;
      throw error;
    }
  }
}

async function readMount(path) {
  const { stdout } = await execFileAsync("findmnt", ["--json", "--target", path, "--output", "UUID,TARGET"]);
  return JSON.parse(stdout).filesystems;
}

export async function verifyDownloadStorage(config, { mounts = readMount, inspect = lstat, space = statfs } = {}) {
  assertDownloadConfiguration(config);
  const paths = [config.root, config.acquisitionRoot, config.downloadRoot, config.stagingRoot];
  let device;
  let acquisitionMount;
  for (const path of paths) {
    await assertNoSymlinks(path);
    const info = await inspect(path);
    if (!info.isDirectory()) throw failure("Download storage directory is missing.");
    if (device === undefined) device = info.dev;
    if (info.dev !== device) throw failure("Staging and publication must be on the same HDD filesystem.");
    const found = await mounts(path);
    if (found?.length !== 1 || found[0].uuid !== config.filesystemUuid || found[0].target === "/") {
      throw failure("The configured download HDD is unavailable.");
    }
    if (!found[0].target) throw failure("Download mount boundary could not be verified.");
    if (path === config.acquisitionRoot) acquisitionMount = found[0].target;
    if ((path === config.downloadRoot || path === config.stagingRoot) && found[0].target !== acquisitionMount) {
      throw failure("Staging and publication must share one mount boundary.");
    }
  }
  const markerPath = join(config.acquisitionRoot, acquisitionMarker);
  await assertNoSymlinks(markerPath);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  if (marker.schemaVersion !== 1 || marker.filesystemUuid !== config.filesystemUuid) {
    throw failure("Download directory ownership could not be verified.");
  }
  await access(config.downloadRoot, constants.W_OK | constants.X_OK);
  await access(config.stagingRoot, constants.W_OK | constants.X_OK);
  const available = await space(config.stagingRoot, { bigint: true });
  if (BigInt(available.bavail) * BigInt(available.bsize) < minimumDownloadFreeBytes) {
    throw failure("Download storage needs at least 1 GiB of free space. No files were removed.");
  }
}

export async function verifyDownloader(executable) {
  try {
    if (!isAbsolute(executable)) throw new Error("An absolute downloader path is required.");
    await assertNoSymlinks(executable);
    if (!(await lstat(executable)).isFile()) throw new Error("Downloader is not a regular file.");
    await access(executable, constants.X_OK);
  } catch {
    throw failure("A reviewed executable downloader must be configured separately.", "downloader_unavailable");
  }
}

export async function downloadReadiness(config) {
  try {
    await verifyDownloadStorage(config);
    await verifyDownloader(config.downloader);
    return { enabled: true, ready: true, reason: null };
  } catch (error) {
    return { enabled: true, ready: false, reason: error.reason || "storage_unavailable" };
  }
}

// Reject links (including hard-linked media) and special files before publication.
// The systemd service is the second boundary protecting all pre-existing media.
export async function assertSafeStagingTree(stage) {
  await assertNoSymlinks(stage);
  async function visit(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1)) {
      throw failure("Staged downloads must contain only regular, unlinked files and directories.");
    }
    if (info.isDirectory()) for (const entry of await readdir(path)) await visit(join(path, entry));
  }
  await visit(stage);
}

export function isDownloadOnlyJob(state) {
  return state?.downloadOnly === true && state.origin === "manual" && !state.missingTracks?.length;
}

export function downloadRequestAllowed(request, { host, port }) {
  const authority = host === "::1" ? `[::1]:${port}` : `${host}:${port}`;
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)
    && request.headers.host === authority
    && (!request.headers.origin || request.headers.origin === `http://${authority}`)
    && (!request.headers["sec-fetch-site"] || ["same-origin", "none"].includes(request.headers["sec-fetch-site"]));
}
