import assert from "node:assert/strict";
import { test } from "node:test";
import { publishedMediaPath } from "../published-media-policy.mjs";

test("media access is restricted to tracks in the published projection", () => {
  const tracks = [{ id: "Visible/Album/01.flac" }];
  assert.equal(publishedMediaPath("Visible/Album/01.flac", tracks, "/music"), "/music/Visible/Album/01.flac");
  assert.equal(publishedMediaPath("Hidden/Album/01.flac", tracks, "/music"), null);
  assert.equal(publishedMediaPath("../../etc/passwd", tracks, "/music"), null);
});

test("malformed published track records fail closed", () => {
  assert.equal(publishedMediaPath("track.flac", null, "/music"), null);
  assert.equal(publishedMediaPath("track.flac", [null, {}, { id: 42 }], "/music"), null);
});
