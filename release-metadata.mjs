const normalized = (value) => String(value || "").normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();

export function selectOriginalReleaseGroup(groups, { artist, title }) {
  const matches = (groups || []).filter((group) =>
    normalized(group.title) === normalized(title)
    && (group["artist-credit"] || []).some((credit) => normalized(credit.artist?.name) === normalized(artist))
    && /^\d{4}/.test(group["first-release-date"] || ""));

  return matches.sort((left, right) => {
    const leftSecondary = new Set(left["secondary-types"] || []);
    const rightSecondary = new Set(right["secondary-types"] || []);
    const leftCanonical = left["primary-type"] === "Album" && leftSecondary.size === 0 ? 1 : 0;
    const rightCanonical = right["primary-type"] === "Album" && rightSecondary.size === 0 ? 1 : 0;
    return rightCanonical - leftCanonical
      || String(left["first-release-date"]).localeCompare(String(right["first-release-date"]))
      || Number(right.score || 0) - Number(left.score || 0);
  })[0];
}
