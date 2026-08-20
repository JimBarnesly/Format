export function safeManifestEntries(manifest) {
  return Array.isArray(manifest)
    ? manifest.filter((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

export function authoritativeManifestEntries(manifest) {
  if (!Array.isArray(manifest)) return null;
  const entries = safeManifestEntries(manifest);
  return entries.length === manifest.length ? entries : null;
}

export function persistedShadowManifest({ authoritative, authoritativeManifest, localManifest }) {
  if (authoritative) return authoritativeManifestEntries(authoritativeManifest) || [];
  return safeManifestEntries(localManifest);
}

function authoritativeManifestComplete(manifest, expectedTrackCount) {
  if (!Number.isInteger(expectedTrackCount) || expectedTrackCount < 1) return false;
  const entries = authoritativeManifestEntries(manifest);
  if (!entries) return false;
  if (entries.length !== expectedTrackCount) return false;
  const positions = new Set();
  const localTrackIds = new Set();
  for (const entry of entries) {
    if (entry.status !== "validated"
      || !Number.isInteger(entry.disc) || entry.disc < 1
      || !Number.isInteger(entry.position) || entry.position < 1
      || typeof entry.title !== "string" || !entry.title.trim()
      || typeof entry.localTrackId !== "string" || !entry.localTrackId) return false;
    const position = `${entry.disc}:${entry.position}`;
    if (positions.has(position) || localTrackIds.has(entry.localTrackId)) return false;
    positions.add(position);
    localTrackIds.add(entry.localTrackId);
  }
  return true;
}

export function authoritativeExpectedTrackCount(media) {
  if (!Array.isArray(media) || media.length === 0) return null;
  let total = 0;
  for (const medium of media) {
    const count = Number(medium?.["track-count"]);
    if (!Number.isInteger(count) || count < 1) return null;
    total += count;
  }
  return total;
}

export function publishedTrackIdsForAlbum(record, albumTrackIds) {
  if (!record?.published || !Array.isArray(albumTrackIds)) return [];
  if (!record.authoritative) return [...albumTrackIds];
  if (!authoritativeManifestComplete(record.manifest, record.expectedTrackCount)) return [];
  const albumIds = new Set(albumTrackIds);
  const manifestIds = record.manifest.map((entry) => entry.localTrackId);
  return manifestIds.every((id) => albumIds.has(id)) ? manifestIds : [];
}

export function shadowPublicationState({
  existing = {},
  authoritativeManifest = null,
  albumIncomplete = false,
  testMode = false
}) {
  const manifestComplete = authoritativeManifestComplete(
    authoritativeManifest,
    existing.expectedTrackCount
  );
  const complete = existing.authoritative ? manifestComplete : !albumIncomplete;
  const mayRetainLegacyPublication = existing.source === "existing-library" && existing.published === true;
  const mayPublishUnverified = mayRetainLegacyPublication || testMode;
  const status = complete
    ? existing.authoritative || mayPublishUnverified ? "published" : "validating"
    : existing.authoritative ? "incomplete" : albumIncomplete ? "incomplete" : "validating";

  return {
    complete,
    status,
    published: status === "published",
    source: existing.source || "local-scan"
  };
}
