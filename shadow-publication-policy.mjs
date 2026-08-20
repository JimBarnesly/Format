export function shadowPublicationState({
  existing = {},
  authoritativeManifest = null,
  albumIncomplete = false,
  testMode = false
}) {
  const manifestComplete = Array.isArray(authoritativeManifest)
    && authoritativeManifest.length > 0
    && authoritativeManifest.every((entry) => entry !== null
      && typeof entry === "object"
      && entry.status === "validated");
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
