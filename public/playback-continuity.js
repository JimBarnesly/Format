const defaultNetworkRetryDelays = [1000, 3000, 10000];

export function createPlaybackContinuity({
  retry,
  advance,
  hasNext,
  report,
  schedule = setTimeout,
  cancel = clearTimeout,
  networkRetryDelays = defaultNetworkRetryDelays,
  mediaRetryDelay = 500
}) {
  let currentTrackId = null;
  let currentSource = null;
  let generation = 0;
  let networkAttempts = 0;
  let mediaAttempts = 0;
  let mediaRetryPending = false;
  let pendingRetry = null;

  const clearPendingRetry = () => {
    if (pendingRetry !== null) cancel(pendingRetry);
    pendingRetry = null;
  };

  const scheduleRetry = (delay, beforeRetry = () => {}) => {
    clearPendingRetry();
    const expectedGeneration = generation;
    const expectedTrackId = currentTrackId;
    pendingRetry = schedule(() => {
      pendingRetry = null;
      if (generation === expectedGeneration && currentTrackId === expectedTrackId) {
        beforeRetry();
        retry(expectedTrackId);
      }
    }, delay);
  };

  return {
    trackChanged(trackId, source) {
      clearPendingRetry();
      generation += 1;
      currentTrackId = trackId;
      currentSource = source;
      networkAttempts = 0;
      mediaAttempts = 0;
      mediaRetryPending = false;
      report("");
    },

    handleError({ code, source }) {
      if (!currentTrackId || source !== currentSource || code === 1) return;
      if (code === 2) {
        mediaRetryPending = false;
        const delay = networkRetryDelays[Math.min(networkAttempts, networkRetryDelays.length - 1)];
        networkAttempts += 1;
        report(`Connection interrupted. Retrying this track in ${Math.ceil(delay / 1000)}s…`);
        scheduleRetry(delay);
        return;
      }

      if (mediaRetryPending) return;
      if (mediaAttempts === 0) {
        mediaRetryPending = true;
        report("This track did not load. Retrying once…");
        scheduleRetry(mediaRetryDelay, () => {
          mediaRetryPending = false;
          mediaAttempts += 1;
        });
        return;
      }

      clearPendingRetry();
      if (hasNext()) {
        advance();
        report("This track could not be played. Skipping to the next track…");
      } else {
        report("This track could not be played. The album has stopped.");
      }
    },

    handleSuccess(source) {
      if (source !== currentSource) return;
      clearPendingRetry();
      networkAttempts = 0;
      mediaRetryPending = false;
      report("");
    },

    dispose() {
      clearPendingRetry();
      generation += 1;
    }
  };
}

export function createPlaybackStatusAnnouncer({
  render,
  schedule = setTimeout,
  cancel = clearTimeout,
  minimumMs = 4000
}) {
  let message = "";
  let clearTimer = null;

  return (nextMessage) => {
    if (!nextMessage) {
      if (!message) render("");
      return;
    }
    if (clearTimer !== null) cancel(clearTimer);
    message = nextMessage;
    render(message);
    clearTimer = schedule(() => {
      clearTimer = null;
      message = "";
      render("");
    }, minimumMs);
  };
}
