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
