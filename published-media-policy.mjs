import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

export function publishedMediaPath(id, publishedTracks, root) {
  if (typeof id !== "string" || !Array.isArray(publishedTracks) || typeof root !== "string") return null;
  const track = publishedTracks.find((entry) => entry !== null
    && typeof entry === "object"
    && typeof entry.id === "string"
    && entry.id === id);
  if (!track) return null;
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, track.id);
  return candidate.startsWith(`${resolvedRoot}${sep}`) ? candidate : null;
}

export async function openPublishedMedia(id, publishedTracks, root) {
  const candidate = publishedMediaPath(id, publishedTracks, root);
  if (!candidate) return null;
  let handle;
  try {
    const resolvedRoot = await realpath(root);
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [resolvedFile, info] = await Promise.all([
      realpath(`/proc/self/fd/${handle.fd}`),
      handle.stat()
    ]);
    if (!info.isFile() || !resolvedFile.startsWith(`${resolvedRoot}${sep}`)) {
      await handle.close();
      return null;
    }
    return handle;
  } catch {
    await handle?.close().catch(() => {});
    return null;
  }
}
