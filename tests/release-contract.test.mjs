import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function text(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("CI runs the declared verification command on the production Node version with FFmpeg", async () => {
  const [workflow, manifest] = await Promise.all([
    text(".github/workflows/verify.yml"),
    text("package.json").then(JSON.parse)
  ]);

  assert.ok(manifest.scripts.verify);
  assert.equal(manifest.engines?.node, ">=22");
  assert.match(workflow, /actions\/setup-node@v4/);
  assert.match(workflow, /node-version:\s*["']?22["']?/);
  assert.match(workflow, /apt-get install[^\n]*ffmpeg/);
  assert.match(workflow, /run:\s*npm run verify/);
});

test("the Docker image contains the application and writable runtime roots", async () => {
  const dockerfile = await text("Dockerfile");

  assert.match(dockerfile, /^COPY \. \.\s*$/m);
  assert.match(dockerfile, /^ENV MUSIC_ROOT=\/music CACHE_DIR=\/cache DATA_DIR=\/data\s*$/m);
  assert.match(dockerfile, /mkdir -p \/music \/cache \/data/);
  assert.match(dockerfile, /^CMD \["node", "server\.mjs"\]\s*$/m);
});

test("Docker context excludes repository and local runtime state", async () => {
  const dockerignore = await text(".dockerignore");
  for (const entry of [".git", ".project-office", "node_modules", "data", "cache"]) {
    assert.match(dockerignore, new RegExp(`^${entry.replace(".", "\\.")}/?$`, "m"));
  }
});
