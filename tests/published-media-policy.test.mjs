import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { test } from "node:test";
import { openPublishedMedia, pipeMediaStream, publishedMediaPath } from "../published-media-policy.mjs";

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

test("published media rejects symlink escapes and keeps the verified inode open", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "format-media-policy-"));
  try {
    const root = join(temporary, "music");
    const outside = join(temporary, "outside.flac");
    const track = join(root, "Artist", "Album", "01.flac");
    await mkdir(join(root, "Artist", "Album"), { recursive: true });
    await writeFile(outside, "outside");
    await writeFile(track, "original");

    const tracks = [{ id: "Artist/Album/01.flac" }];
    const handle = await openPublishedMedia("Artist/Album/01.flac", tracks, root);
    assert.ok(handle);
    await rename(track, `${track}.old`);
    await symlink(outside, track);
    assert.equal(await handle.readFile("utf8"), "original");
    await handle.close();

    assert.equal(await openPublishedMedia("Artist/Album/01.flac", tracks, root), null);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("client disconnect destroys the media stream and closes its descriptor", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "format-media-disconnect-"));
  try {
    const root = join(temporary, "music");
    const track = join(root, "track.flac");
    await mkdir(root, { recursive: true });
    await writeFile(track, Buffer.alloc(4096));
    const handle = await openPublishedMedia("track.flac", [{ id: "track.flac" }], root);
    const response = new PassThrough({ highWaterMark: 1 });
    const stream = pipeMediaStream(handle.createReadStream(), response);
    const closed = once(stream, "close");
    response.emit("close");
    await closed;
    await assert.rejects(handle.stat(), { code: "EBADF" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
