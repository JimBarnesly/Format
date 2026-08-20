export function safeManifestEntries(manifest) {
  return Array.isArray(manifest)
    ? manifest.filter((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

export function persistedShadowManifest({ authoritative, authoritativeManifest, localManifest }) {
  return safeManifestEntries(authoritative ? authoritativeManifest : localManifest);
}

function authoritativeManifestComplete(manifest, expectedTrackCount) {
  if (!Number.isInteger(expectedTrackCount) || expectedTrackCount < 1) return false;
  const entries = safeManifestEntries(manifest);
  if (entries.length !== expectedTrackCount) return false;
  const positions = new Set();
  for (const entry of entries) {
    if (entry.status !== "validated"
      || !Number.isInteger(entry.disc) || entry.disc < 1
      || !Number.isInteger(entry.position) || entry.position < 1
      || typeof entry.title !== "string" || !entry.title.trim()
      || typeof entry.localTrackId !== "string" || !entry.localTrackId) return false;
    const position = `${entry.disc}:${entry.position}`;
    if (positions.has(position)) return false;
    positions.add(position);
  }
  return true;
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
