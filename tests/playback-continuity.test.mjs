import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlaybackContinuity, createPlaybackStatusAnnouncer } from "../public/playback-continuity.js";

function harness(options = {}) {
  const scheduled = [];
  const retries = [];
  const advances = [];
  const reports = [];
  const controller = createPlaybackContinuity({
    retry: (trackId) => retries.push(trackId),
    advance: () => advances.push(true),
    hasNext: () => options.hasNext ?? true,
    report: (message) => reports.push(message),
    schedule: (callback, delay) => {
      const task = { callback, delay, cancelled: false };
      scheduled.push(task);
      return task;
    },
    cancel: (task) => { task.cancelled = true; }
  });
  return { controller, scheduled, retries, advances, reports };
}

test("network interruption retries the same track without advancing the album", () => {
  const { controller, scheduled, retries, advances, reports } = harness();
  controller.trackChanged("track-1", "/api/audio?id=track-1");

  controller.handleError({ code: 2, source: "/api/audio?id=track-1" });

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 1000);
  scheduled[0].callback();
  assert.deepEqual(retries, ["track-1"]);
  assert.deepEqual(advances, []);
  assert.match(reports.at(-1), /connection interrupted/i);
});

test("network retries back off and remain capped on the current track", () => {
  const { controller, scheduled } = harness();
  controller.trackChanged("track-1", "/audio/1");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    controller.handleError({ code: 2, source: "/audio/1" });
    scheduled.at(-1).callback();
  }

  assert.deepEqual(scheduled.map((task) => task.delay), [1000, 3000, 10000, 10000, 10000]);
});

test("duplicate network errors coalesce until the retry executes", () => {
  const { controller, scheduled, retries } = harness();
  controller.trackChanged("track-1", "/audio/1");

  controller.handleError({ code: 2, source: "/audio/1" });
  controller.handleError({ code: 2, source: "/audio/1" });

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 1000);
  scheduled[0].callback();
  assert.deepEqual(retries, ["track-1"]);
  controller.handleError({ code: 2, source: "/audio/1" });
  assert.equal(scheduled[1].delay, 3000);
});

test("mixed error classes coalesce until the current retry executes", () => {
  const { controller, scheduled, retries, advances } = harness();
  controller.trackChanged("track-1", "/audio/1");

  controller.handleError({ code: 2, source: "/audio/1" });
  controller.handleError({ code: 3, source: "/audio/1" });
  assert.equal(scheduled.length, 1);
  assert.deepEqual(advances, []);

  scheduled[0].callback();
  assert.deepEqual(retries, ["track-1"]);
  controller.handleError({ code: 3, source: "/audio/1" });
  assert.equal(scheduled[1].delay, 500);
});

test("an aborted load does not retry or advance playback", () => {
  const { controller, scheduled, retries, advances, reports } = harness();
  controller.trackChanged("track-1", "/audio/1");

  controller.handleError({ code: 1, source: "/audio/1" });

  assert.deepEqual(scheduled, []);
  assert.deepEqual(retries, []);
  assert.deepEqual(advances, []);
  assert.equal(reports.at(-1), "");
});

test("an unreadable track is retried once then skipped when another track exists", () => {
  const { controller, scheduled, retries, advances, reports } = harness();
  controller.trackChanged("track-1", "/audio/1");

  controller.handleError({ code: 3, source: "/audio/1" });
  assert.equal(scheduled[0].delay, 500);
  scheduled[0].callback();
  assert.deepEqual(retries, ["track-1"]);

  controller.handleError({ code: 3, source: "/audio/1" });
  assert.deepEqual(advances, [true]);
  assert.match(reports.at(-1), /skipping/i);
});

test("duplicate errors cannot skip a track before its retry executes", () => {
  const { controller, scheduled, retries, advances } = harness();
  controller.trackChanged("track-1", "/audio/1");

  controller.handleError({ code: 3, source: "/audio/1" });
  controller.handleError({ code: 3, source: "/audio/1" });

  assert.equal(scheduled.length, 1);
  assert.deepEqual(retries, []);
  assert.deepEqual(advances, []);
  scheduled[0].callback();
  assert.deepEqual(retries, ["track-1"]);
  controller.handleError({ code: 3, source: "/audio/1" });
  assert.deepEqual(advances, [true]);
});

test("skip status survives the synchronous switch to the next track", () => {
  const reports = [];
  let executeRetry;
  let controller;
  controller = createPlaybackContinuity({
    retry: () => {},
    hasNext: () => true,
    report: (message) => reports.push(message),
    advance: () => controller.trackChanged("track-2", "/audio/2"),
    schedule: (callback) => { executeRetry = callback; return callback; }
  });
  controller.trackChanged("track-1", "/audio/1");
  controller.handleError({ code: 3, source: "/audio/1" });
  executeRetry();
  controller.handleError({ code: 3, source: "/audio/1" });

  assert.match(reports.at(-1), /skipping/i);
});

test("an unreadable final track stops with a useful message", () => {
  const { controller, scheduled, advances, reports } = harness({ hasNext: false });
  controller.trackChanged("track-1", "/audio/1");
  controller.handleError({ code: 4, source: "/audio/1" });
  scheduled[0].callback();
  controller.handleError({ code: 4, source: "/audio/1" });

  assert.deepEqual(advances, []);
  assert.match(reports.at(-1), /could not be played/i);
});

test("a stale error or retry cannot disrupt a newly selected track", () => {
  const { controller, scheduled, retries, advances } = harness();
  controller.trackChanged("track-1", "/audio/1");
  controller.handleError({ code: 2, source: "/audio/1" });
  const staleRetry = scheduled[0];

  controller.trackChanged("track-2", "/audio/2");
  assert.equal(staleRetry.cancelled, true);
  controller.handleError({ code: 3, source: "/audio/1" });
  staleRetry.callback();

  assert.deepEqual(retries, []);
  assert.deepEqual(advances, []);
});

test("successful loading clears network backoff and status", () => {
  const { controller, scheduled, reports } = harness();
  controller.trackChanged("track-1", "/audio/1");
  controller.handleError({ code: 2, source: "/audio/1" });

  controller.handleSuccess("/audio/1");

  assert.equal(scheduled[0].cancelled, true);
  assert.equal(reports.at(-1), "");
  controller.handleError({ code: 2, source: "/audio/1" });
  assert.equal(scheduled.at(-1).delay, 1000);
});

test("a cancelled same-track retry callback cannot execute after success", () => {
  const { controller, scheduled, retries } = harness();
  controller.trackChanged("track-1", "/audio/1");
  controller.handleError({ code: 2, source: "/audio/1" });
  const cancelledRetry = scheduled[0];

  controller.handleSuccess("/audio/1");
  assert.equal(cancelledRetry.cancelled, true);
  cancelledRetry.callback();

  assert.deepEqual(retries, []);
});

test("a corrupt track that briefly becomes playable is still skipped after its retry", () => {
  const { controller, scheduled, advances } = harness();
  controller.trackChanged("track-1", "/audio/1");
  controller.handleError({ code: 3, source: "/audio/1" });
  scheduled[0].callback();
  controller.handleSuccess("/audio/1");

  controller.handleError({ code: 3, source: "/audio/1" });

  assert.deepEqual(advances, [true]);
});

test("playback announcements remain visible long enough for assistive technology", () => {
  const rendered = [];
  const scheduled = [];
  const announce = createPlaybackStatusAnnouncer({
    render: (message) => rendered.push(message),
    schedule: (callback, delay) => {
      const task = { callback, delay, cancelled: false };
      scheduled.push(task);
      return task;
    },
    cancel: (task) => { task.cancelled = true; }
  });

  announce("Skipping an unreadable track…");
  announce("");

  assert.equal(rendered.at(-1), "Skipping an unreadable track…");
  assert.equal(scheduled.at(-1).delay, 4000);
  scheduled.at(-1).callback();
  assert.equal(rendered.at(-1), "");
});

test("a cancelled clear timer cannot erase a newer playback announcement", () => {
  const rendered = [];
  const scheduled = [];
  const announce = createPlaybackStatusAnnouncer({
    render: (message) => rendered.push(message),
    schedule: (callback) => {
      const task = { callback, cancelled: false };
      scheduled.push(task);
      return task;
    },
    cancel: (task) => { task.cancelled = true; }
  });

  announce("First status");
  const staleClear = scheduled[0];
  announce("Second status");
  assert.equal(staleClear.cancelled, true);
  staleClear.callback();

  assert.equal(rendered.at(-1), "Second status");
});
