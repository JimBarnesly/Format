import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("the browser player wires continuity recovery to media load and error events", () => {
  assert.match(app, /import \{ createPlaybackContinuity, createPlaybackStatusAnnouncer \} from "\.\/playback-continuity\.js"/);
  assert.match(app, /const playbackContinuity = createPlaybackContinuity\(/);
  assert.match(app, /playbackContinuity\.trackChanged\(track\.id, audio\.src\)/);
  assert.match(app, /element\.oncanplay = \(\) => \{[\s\S]*if \(element !== audio\) return;[\s\S]*playbackContinuity\.handleSuccess\(element\.currentSrc\)/);
  assert.match(app, /playbackContinuity\.handleError\(\{ code: element\.error\?\.code, source: element\.currentSrc \}\)/);
  assert.match(app, /let audio = \$\("#audio"\)/);
  assert.match(app, /function replaceAudioElement\(\)/);
  assert.match(app, /if \(element !== audio\) return/);
  assert.match(app, /function requestPlayback\(element = audio\)/);
  assert.match(app, /void element\.play\(\)\.catch/);
  assert.doesNotMatch(app, /if \(autoplay\) audio\.play\(\)/);
});

test("playback recovery status is announced without replacing album metadata", () => {
  assert.match(html, /id="player-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(app, /createPlaybackStatusAnnouncer\(/);
  assert.match(app, /render: \(message\) => \{ \$\("#player-status"\)\.textContent = message; \}/);
});
