import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { shadowPublicationState } from "../shadow-publication-policy.mjs";

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

test("library reconciliation uses the fail-closed publication policy", () => {
  assert.match(serverSource, /import \{ shadowPublicationState \} from "\.\/shadow-publication-policy\.mjs"/);
  assert.match(serverSource, /shadowPublicationState\(\{[\s\S]*existing,[\s\S]*authoritativeManifest,[\s\S]*albumIncomplete: album\.incomplete,[\s\S]*testMode[\s\S]*\}\)/);
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

test("an authoritative complete manifest is published", () => {
  const result = shadowPublicationState({
    existing: { authoritative: true, source: "acquisition" },
    authoritativeManifest: [
      { status: "validated" },
      { status: "validated" }
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
    existing: { authoritative: true, source: "acquisition" },
    authoritativeManifest: [{ status: "validated" }, { status: "missing" }],
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
