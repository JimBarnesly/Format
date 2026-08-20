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
  let pendingRetry = null;
  let retryToken = 0;

  const clearPendingRetry = () => {
    retryToken += 1;
    if (pendingRetry !== null) cancel(pendingRetry);
    pendingRetry = null;
  };

  const scheduleRetry = (delay, beforeRetry = () => {}) => {
    clearPendingRetry();
    const expectedToken = retryToken;
    const expectedGeneration = generation;
    const expectedTrackId = currentTrackId;
    pendingRetry = schedule(() => {
      if (retryToken !== expectedToken
        || generation !== expectedGeneration
        || currentTrackId !== expectedTrackId) return;
      retryToken += 1;
      pendingRetry = null;
      beforeRetry();
      retry(expectedTrackId);
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
      report("");
    },

    handleError({ code, source }) {
      if (!currentTrackId || source !== currentSource || code === 1) return;
      if (pendingRetry !== null) return;

      if (code === 2) {
        const delay = networkRetryDelays[Math.min(networkAttempts, networkRetryDelays.length - 1)];
        report(`Connection interrupted. Retrying this track in ${Math.ceil(delay / 1000)}s…`);
        scheduleRetry(delay, () => { networkAttempts += 1; });
        return;
      }

      if (mediaAttempts === 0) {
        report("This track did not load. Retrying once…");
        scheduleRetry(mediaRetryDelay, () => { mediaAttempts += 1; });
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
  let clearToken = 0;

  return (nextMessage) => {
    if (!nextMessage) {
      if (!message) render("");
      return;
    }
    clearToken += 1;
    const expectedToken = clearToken;
    if (clearTimer !== null) cancel(clearTimer);
    message = nextMessage;
    render(message);
    clearTimer = schedule(() => {
      if (clearToken !== expectedToken) return;
      clearTimer = null;
      message = "";
      render("");
    }, minimumMs);
  };
}
