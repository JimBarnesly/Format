import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  authoritativeExpectedTrackCount,
  authoritativeManifestEntries,
  persistedShadowManifest,
  publishedTrackIdsForAlbum,
  safeManifestEntries,
  shadowPublicationState
} from "../shadow-publication-policy.mjs";

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

test("library reconciliation uses the fail-closed publication policy", () => {
  assert.match(serverSource, /authoritativeExpectedTrackCount,[\s\S]*authoritativeManifestEntries,[\s\S]*persistedShadowManifest,[\s\S]*publishedTrackIdsForAlbum,[\s\S]*safeManifestEntries,[\s\S]*shadowPublicationState/);
  assert.match(serverSource, /shadowPublicationState\(\{[\s\S]*existing,[\s\S]*authoritativeManifest,[\s\S]*albumIncomplete: album\.incomplete,[\s\S]*testMode[\s\S]*\}\)/);
  assert.match(serverSource, /authoritativeManifestEntries\(existing\.manifest\)\?\.map/);
  assert.match(serverSource, /expectedTrackCount: existing\.authoritative \? existing\.expectedTrackCount : album\.expectedTracks/);
  assert.match(serverSource, /persistedShadowManifest\(\{[\s\S]*authoritative: existing\.authoritative,[\s\S]*authoritativeManifest,[\s\S]*localManifest[\s\S]*\}\)/);
});

test("a locally complete album remains unverified across repeated scans", () => {
  const first = shadowPublicationState({ existing: {}, albumIncomplete: false });
  assert.deepEqual(first, {
    complete: true,
    status: "validating",
    published: false,
    source: "local-scan"
  });

  const second = shadowPublicationState({
    existing: { source: first.source, published: first.published },
    albumIncomplete: false
  });
  assert.deepEqual(second, first);
});

test("an authoritative record without a manifest remains unpublished", () => {
  const result = shadowPublicationState({
    existing: { authoritative: true, status: "published", published: true },
    authoritativeManifest: null,
    albumIncomplete: false
  });

  assert.deepEqual(result, {
    complete: false,
    status: "incomplete",
    published: false,
    source: "local-scan"
  });
});

test("malformed authoritative manifest entries fail closed without crashing reconciliation", () => {
  assert.doesNotThrow(() => shadowPublicationState({
    existing: { authoritative: true, source: "acquisition" },
    authoritativeManifest: [null, {}, "validated"],
    albumIncomplete: false
  }));
  const result = shadowPublicationState({
    existing: { authoritative: true, source: "acquisition" },
    authoritativeManifest: [null, {}, "validated"],
    albumIncomplete: false
  });
  assert.equal(result.status, "incomplete");
  assert.equal(result.published, false);
});

test("server manifest preprocessing removes values that cannot be dereferenced", () => {
  assert.deepEqual(safeManifestEntries([null, undefined, "track", [], { title: "Valid shape" }]), [
    { title: "Valid shape" }
  ]);
});

test("malformed authoritative arrays are rejected rather than sanitized into publication", () => {
  const valid = { disc: 1, position: 1, title: "One", localTrackId: "local-1", status: "validated" };
  assert.equal(authoritativeManifestEntries([null, valid]), null);
  assert.equal(authoritativeManifestEntries("invalid"), null);
  assert.deepEqual(authoritativeManifestEntries([valid]), [valid]);
  assert.deepEqual(persistedShadowManifest({
    authoritative: true,
    authoritativeManifest: [null, valid],
    localManifest: [valid]
  }), []);
  assert.match(serverSource, /authoritativeManifestEntries\(existing\.manifest\)\?\.map/);
});

test("missing authoritative data is never replaced with locally fabricated authority", () => {
  const localManifest = [{ disc: 1, position: 1, title: "Local", localTrackId: "local-1", status: "local_unverified" }];

  assert.deepEqual(persistedShadowManifest({
    authoritative: true,
    authoritativeManifest: null,
    localManifest
  }), []);
  assert.deepEqual(persistedShadowManifest({
    authoritative: false,
    authoritativeManifest: null,
    localManifest
  }), localManifest);
});

test("a truncated authoritative manifest cannot erase the expected track total", () => {
  const result = shadowPublicationState({
    existing: { authoritative: true, source: "acquisition", expectedTrackCount: 2 },
    authoritativeManifest: [
      { disc: 1, position: 1, title: "One", localTrackId: "local-1", status: "validated" }
    ],
    albumIncomplete: false
  });

  assert.equal(result.complete, false);
  assert.equal(result.published, false);
  assert.equal(result.status, "incomplete");
});

test("duplicate or incomplete track identities cannot publish", () => {
  const base = { authoritative: true, source: "acquisition", expectedTrackCount: 2 };
  for (const authoritativeManifest of [
    [
      { disc: 1, position: 1, title: "One", localTrackId: "local-1", status: "validated" },
      { disc: 1, position: 1, title: "Duplicate", localTrackId: "local-2", status: "validated" }
    ],
    [
      { disc: 1, position: 1, title: "", localTrackId: "local-1", status: "validated" },
      { disc: 1, position: 2, title: "Two", localTrackId: "", status: "validated" }
    ],
    [
      { disc: 1, position: 1, title: "One", localTrackId: "local-1", status: "validated" },
      { disc: 1, position: 2, title: "Two", localTrackId: "local-1", status: "validated" }
    ]
  ]) {
    const result = shadowPublicationState({ existing: base, authoritativeManifest, albumIncomplete: false });
    assert.equal(result.published, false);
    assert.equal(result.status, "incomplete");
  }
});

test("direct identification uses declared medium totals rather than manifest length", () => {
  assert.equal(authoritativeExpectedTrackCount([
    { "track-count": 2, tracks: [{ position: 1 }] },
    { "track-count": 1, tracks: [] }
  ]), 3);
  assert.equal(authoritativeExpectedTrackCount([{ tracks: [{ position: 1 }] }]), null);
  assert.equal(authoritativeExpectedTrackCount([{ "track-count": "1", tracks: [{ position: 1 }] }]), null);
  assert.equal(authoritativeExpectedTrackCount([{ "track-count": true, tracks: [{ position: 1 }] }]), null);
  assert.match(serverSource, /const expectedTrackCount = authoritativeExpectedTrackCount\(selected\.media\)/);
  assert.match(serverSource, /existing: \{ \.\.\.record, authoritative: true, expectedTrackCount \},[\s\S]*authoritativeManifest: manifest/);
});

test("authoritative track positions must form contiguous discs and tracks", () => {
  const base = { authoritative: true, source: "acquisition", expectedTrackCount: 1 };
  for (const authoritativeManifest of [
    [{ disc: 1, position: 2, title: "Missing first track", localTrackId: "a", status: "validated" }],
    [{ disc: 2, position: 1, title: "Missing first disc", localTrackId: "a", status: "validated" }]
  ]) {
    assert.equal(shadowPublicationState({ existing: base, authoritativeManifest }).published, false);
  }

  const valid = shadowPublicationState({
    existing: { ...base, expectedTrackCount: 3 },
    authoritativeManifest: [
      { disc: 1, position: 1, title: "One", localTrackId: "a", status: "validated" },
      { disc: 1, position: 2, title: "Two", localTrackId: "b", status: "validated" },
      { disc: 2, position: 1, title: "Three", localTrackId: "c", status: "validated" }
    ]
  });
  assert.equal(valid.published, true);
});

test("authoritative publication exposes only validated manifest tracks", () => {
  const record = {
    authoritative: true,
    published: true,
    expectedTrackCount: 2,
    manifest: [
      { disc: 1, position: 1, title: "One", localTrackId: "a", status: "validated" },
      { disc: 1, position: 2, title: "Two", localTrackId: "b", status: "validated" }
    ]
  };
  assert.deepEqual(publishedTrackIdsForAlbum(record, ["a", "b", "bonus"]), ["a", "b"]);
  assert.deepEqual(publishedTrackIdsForAlbum({ ...record, manifest: record.manifest.slice(0, 1) }, ["a", "b"]), []);
  assert.deepEqual(publishedTrackIdsForAlbum({ source: "existing-library", published: true }, ["a", "b"]), ["a", "b"]);
  assert.match(serverSource, /publishedTrackIdsForAlbum\(record, album\.trackIds\)/);
});

test("an authoritative complete manifest is published", () => {
  const result = shadowPublicationState({
    existing: { authoritative: true, source: "acquisition", expectedTrackCount: 2 },
    authoritativeManifest: [
      { disc: 1, position: 1, title: "One", localTrackId: "local-1", status: "validated" },
      { disc: 1, position: 2, title: "Two", localTrackId: "local-2", status: "validated" }
    ],
    albumIncomplete: false
  });

  assert.deepEqual(result, {
    complete: true,
    status: "published",
    published: true,
    source: "acquisition"
  });
});

test("an authoritative manifest with a missing track stays incomplete", () => {
  const result = shadowPublicationState({
    existing: { authoritative: true, source: "acquisition", expectedTrackCount: 2 },
    authoritativeManifest: [
      { disc: 1, position: 1, title: "One", localTrackId: "local-1", status: "validated" },
      { disc: 1, position: 2, title: "Two", localTrackId: null, status: "missing" }
    ],
    albumIncomplete: false
  });

  assert.equal(result.complete, false);
  assert.equal(result.status, "incomplete");
  assert.equal(result.published, false);
});

test("only an explicitly published legacy record retains unverified publication", () => {
  const published = shadowPublicationState({
    existing: { source: "existing-library", published: true },
    albumIncomplete: false
  });
  assert.equal(published.status, "published");
  assert.equal(published.published, true);

  const neverPublished = shadowPublicationState({
    existing: { source: "existing-library", published: false },
    albumIncomplete: false
  });
  assert.equal(neverPublished.status, "validating");
  assert.equal(neverPublished.published, false);
});

test("test fixtures may bypass identification without changing production provenance", () => {
  const result = shadowPublicationState({ existing: {}, albumIncomplete: false, testMode: true });
  assert.equal(result.status, "published");
  assert.equal(result.published, true);
  assert.equal(result.source, "local-scan");
});
