import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function text(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("CI runs host verification and executable container acceptance", async () => {
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
  assert.match(workflow, /docker build --tag format:verify \./);
  assert.match(workflow, /docker run --rm --user 1000:1000 format:verify npm run verify/);
  assert.match(workflow, /docker run --rm format:verify spotiflac --help/);
  assert.match(workflow, /docker restart format-verify/);
  assert.match(workflow, /curl --fail[^\n]*\/api\/bootstrap/);
  assert.match(workflow, /writeFileSync\("\/cache\/ci-write"/);
  assert.match(workflow, /writeFileSync\("\/data\/ci-write"/);
  assert.match(workflow, /writeFileSync\("\/music\/ci-write"/);
});

test("the Docker image is a non-root standalone application runtime", async () => {
  const dockerfile = await text("Dockerfile");

  assert.match(dockerfile, /^ARG SPOTIFLAC_VERSION=0\.7\.0$/m);
  assert.match(dockerfile, /SpotiFLAC==\$\{SPOTIFLAC_VERSION\}/);
  assert.match(dockerfile, /^COPY --chown=node:node \. \.\s*$/m);
  assert.match(dockerfile, /^ENV MUSIC_ROOT=\/music CACHE_DIR=\/cache DATA_DIR=\/data\s*$/m);
  assert.match(dockerfile, /mkdir -p \/music \/cache \/data[\s\S]*chown -R node:node \/music \/cache \/data/);
  assert.match(dockerfile, /^USER node\s*$/m);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.match(dockerfile, /process\.env\.PORT/);
  assert.match(dockerfile, /\$\{port\}\/api\/bootstrap/);
  assert.match(dockerfile, /^CMD \["node", "server\.mjs"\]\s*$/m);
});

test("acquisition runtime paths are configurable and container music is writable", async () => {
  const [server, compose] = await Promise.all([text("server.mjs"), text("compose.yaml")]);

  assert.match(server, /const spotiflacCwd = resolve\(process\.env\.SPOTIFLAC_CWD \|\| process\.cwd\(\)\)/);
  assert.match(server, /cwd: spotiflacCwd/);
  assert.doesNotMatch(server, /\/home\/jake\/\.openclaw\/skills\/spotiflac/);
  assert.doesNotMatch(server, /\/home\/jake\/\.local\/bin/);
  assert.match(compose, /\/home\/jake\/Music:\/music:rw/);
  assert.doesNotMatch(compose, /\.\/:\/app/);
});

test("Docker context excludes repository and local runtime state", async () => {
  const dockerignore = await text(".dockerignore");
  for (const entry of [".git", ".project-office", "node_modules", "data", "cache"]) {
    assert.match(dockerignore, new RegExp(`^${entry.replace(".", "\\.")}/?$`, "m"));
  }
});
