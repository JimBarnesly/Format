import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("the browser player wires continuity recovery to media load and error events", () => {
  assert.match(app, /import \{ createPlaybackContinuity \} from "\.\/playback-continuity\.js"/);
  assert.match(app, /const playbackContinuity = createPlaybackContinuity\(/);
  assert.match(app, /playbackContinuity\.trackChanged\(track\.id, audio\.src\)/);
  assert.match(app, /audio\.oncanplay = \(\) => playbackContinuity\.handleSuccess\(audio\.currentSrc\)/);
  assert.match(app, /playbackContinuity\.handleError\(\{ code: audio\.error\?\.code, source: audio\.currentSrc \}\)/);
});

test("playback recovery status is announced without replacing album metadata", () => {
  assert.match(html, /id="player-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(app, /\$\("#player-status"\)\.textContent = message/);
});
