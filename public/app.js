const state = { library: null, queue: [], index: -1, album: null, playingAlbum: null, playingArtworkUrl: null };
let coverFlowCleanup = () => {};
let playSelectedLibraryAlbum = () => {};
let enterLibraryAtAlbum = () => {};
let turntableTimer = 0;
let libraryIdleTimer = 0;
const $ = (selector) => document.querySelector(selector);
const audio = $("#audio");
const pages = new Set(["discover", "library", "downloads"]);
let lookupRateLimit = { active: false, until: null, remainingMs: 0 };
const acquisitionBadges = new Map();
let lastActiveDownloadId = null;
let dismissedDownloadId = null;
let downloadNoticeTimer = 0;
let screenWakeLock = null;

async function keepPlayerScreenAwake() {
  if (!navigator.wakeLock || screenWakeLock || document.visibilityState !== "visible") return;
  try {
    screenWakeLock = await navigator.wakeLock.request("screen");
    screenWakeLock.addEventListener("release", () => { screenWakeLock = null; });
  } catch {
    // Desktop power settings remain the fallback on platforms without Wake Lock permission.
  }
}

document.addEventListener("pointerdown", keepPlayerScreenAwake, { once: true });
document.addEventListener("visibilitychange", keepPlayerScreenAwake);

function renderRateLimitClock() {
  const clock = $("#rate-limit-clock");
  const remaining = lookupRateLimit.until ? Math.max(0, new Date(lookupRateLimit.until).getTime() - Date.now()) : 0;
  clock.classList.toggle("active", remaining > 0);
  if (remaining <= 0) {
    $("#rate-limit-time").textContent = "00:00";
    return;
  }
  const seconds = Math.ceil(remaining / 1000);
  $("#rate-limit-time").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

async function refreshRateLimitClock() {
  try {
    lookupRateLimit = await fetch("/api/rate-limit", { cache: "no-store" }).then((response) => response.json());
    renderRateLimitClock();
  } catch {
    // Download and library status already report service connectivity.
  }
}

function showPage(name, updateHash = true) {
  const page = pages.has(name) ? name : "discover";
  const wasLibrary = Boolean(document.querySelector("#page-library.active-page"));
  document.querySelectorAll(".page").forEach((node) => node.classList.toggle("active-page", node.id === `page-${page}`));
  document.querySelectorAll("[data-page-link]").forEach((node) => node.classList.toggle("active", node.dataset.pageLink === page));
  if (updateHash && location.hash !== `#${page}`) history.pushState(null, "", `#${page}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (page === "library") requestAnimationFrame(() => {
    if (!wasLibrary) enterLibraryAtAlbum();
    $("#albums")?.focus({ preventScroll: true });
    scheduleTurntableReturn();
  });
}

window.addEventListener("hashchange", () => showPage(location.hash.slice(1), false));

const formatTime = (seconds) => {
  if (!Number.isFinite(seconds)) return "0:00";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
};
const coverUrl = (trackId) => `/api/cover?id=${encodeURIComponent(trackId)}`;
const getTrack = (id) => state.library.tracks.find((track) => track.id === id);
const normalizedLabel = (value) => String(value || "").normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function dismissTurntable() {
  clearTimeout(turntableTimer);
  const stage = $("#turntable-stage");
  stage.classList.remove("active", "spinning", "paused");
  stage.setAttribute("aria-hidden", "true");
  $("#albums").classList.remove("album-launching");
  $("#albums").querySelectorAll(".fly-left,.fly-right,.turntable-source").forEach((card) => {
    card.classList.remove("fly-left", "fly-right", "turntable-source");
  });
}

function scheduleTurntableReturn() {
  clearTimeout(libraryIdleTimer);
  if (audio.paused || !state.playingAlbum || !document.querySelector("#page-library.active-page")
    || $("#turntable-stage").classList.contains("active")) return;
  libraryIdleTimer = setTimeout(() => {
    if (!audio.paused && state.playingAlbum && document.querySelector("#page-library.active-page")) {
      launchTurntable(state.playingAlbum, null, false);
    }
  }, 30_000);
}

function resumeLibraryBrowsing() {
  dismissTurntable();
  scheduleTurntableReturn();
}

function loadTurntableArtwork(album, cover) {
  const albumId = album.id || `${album.artist}\0${album.title}`;
  if (cover.dataset.albumId === albumId && cover.classList.contains("has-art") && cover.style.backgroundImage) return;
  cover.dataset.albumId = albumId;
  cover.classList.remove("has-art");
  const candidates = album.trackIds.map(coverUrl);
  let index = 0;
  const tryNext = () => {
    const artworkUrl = candidates[index++];
    if (!artworkUrl) {
      cover.style.backgroundImage = "";
      state.playingArtworkUrl = null;
      return;
    }
    const image = new Image();
    image.onload = () => {
      if (cover.dataset.albumId !== albumId) return;
      state.playingArtworkUrl = artworkUrl;
      cover.style.backgroundImage = `url("${artworkUrl}")`;
      cover.classList.add("has-art");
    };
    image.onerror = tryNext;
    image.src = artworkUrl;
  };
  if (state.playingArtworkUrl && state.playingAlbum?.id === album.id) {
    cover.style.backgroundImage = `url("${state.playingArtworkUrl}")`;
    cover.classList.add("has-art");
  } else {
    tryNext();
  }
}

function launchTurntable(album, sourceCard = null, useActiveSource = true) {
  if (!document.querySelector("#page-library.active-page") || !album) return;
  dismissTurntable();
  clearTimeout(libraryIdleTimer);
  const flow = $("#albums");
  const cards = [...flow.querySelectorAll(".card")];
  const activeCard = flow.querySelector(".active-cover");
  const selected = sourceCard || (useActiveSource ? activeCard : null);
  const selectedIndex = Math.max(0, cards.indexOf(selected || activeCard));
  cards.forEach((card, index) => card.classList.add(index < selectedIndex ? "fly-left" : index > selectedIndex ? "fly-right" : "turntable-source"));
  flow.classList.add("album-launching");

  const stage = $("#turntable-stage");
  const cover = $("#turntable-cover");
  const sourceCover = selected?.querySelector(".cover");
  const sourceBounds = sourceCover?.getBoundingClientRect();
  const stageBounds = stage.getBoundingClientRect();
  const targetSize = Math.min(stageBounds.height * .68, stageBounds.width * .68);
  const sourceCentreX = sourceBounds ? sourceBounds.left + sourceBounds.width / 2 : innerWidth / 2;
  const sourceCentreY = sourceBounds ? sourceBounds.top + sourceBounds.height / 2 : innerHeight / 2;
  stage.style.setProperty("--start-x", `${sourceCentreX - innerWidth / 2}px`);
  stage.style.setProperty("--start-y", `${sourceCentreY - (72 + stageBounds.height * .48)}px`);
  stage.style.setProperty("--start-scale", String(sourceBounds ? sourceBounds.width / Math.max(targetSize * .86, 1) : .4));
  loadTurntableArtwork(album, cover);
  cover.querySelector("strong").textContent = album.artist || "Unknown artist";
  cover.querySelector("small").textContent = album.title || "Unknown album";
  $("#turntable-caption").textContent = `${album.artist} — ${album.title}`;
  stage.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => stage.classList.add("active"));
  turntableTimer = setTimeout(() => stage.classList.add("spinning"), 1100);
}

function playTrackIds(ids, start = 0, album = null, sourceCard = null) {
  state.queue = ids;
  state.index = start;
  const nextPlayingAlbum = album || state.library.albums.find((item) => item.trackIds.includes(ids[start])) || null;
  if (state.playingAlbum?.id !== nextPlayingAlbum?.id) state.playingArtworkUrl = null;
  state.playingAlbum = nextPlayingAlbum;
  if (state.playingAlbum) launchTurntable(state.playingAlbum, sourceCard);
  loadCurrent(true);
}

function loadCurrent(autoplay = false) {
  const track = getTrack(state.queue[state.index]);
  if (!track) return;
  audio.src = `/api/audio?id=${encodeURIComponent(track.id)}`;
  $("#player-title").textContent = track.title;
  $("#player-artist").textContent = track.artist;
  $("#player-album").textContent = track.album || state.playingAlbum?.title || "";
  $("#turntable-caption").textContent = track.title;
  $("#player-cover").style.backgroundImage = `url("${coverUrl(track.id)}")`;
  if (autoplay) audio.play();
}

function togglePlayback() {
  if (!audio.src) return;
  if (audio.paused) audio.play();
  else audio.pause();
}

function previousTrack() {
  if (state.index <= 0) return;
  state.index--;
  loadCurrent(true);
}

function nextTrack() {
  if (state.index >= state.queue.length - 1) return;
  state.index++;
  loadCurrent(true);
}

function loadAlbumCover(cover) {
  if (!cover?.dataset.coverUrl || cover.dataset.coverLoading) return;
  cover.dataset.coverLoading = "true";
  const image = new Image();
  image.onload = () => {
    cover.style.backgroundImage = `url("${cover.dataset.coverUrl}")`;
    cover.classList.add("has-cover");
    delete cover.dataset.coverLoading;
  };
  image.onerror = () => {
    cover.classList.add("missing-cover");
    delete cover.dataset.coverLoading;
  };
  image.src = cover.dataset.coverUrl;
}

function albumCard(album, { lazyCover = false } = {}) {
  const trackId = album.trackIds[0];
  const node = document.createElement("article");
  node.className = "card";
  const missingCount = album.missingTracks?.length || 0;
  const incompleteLabel = missingCount
    ? `Incomplete album: ${missingCount} track${missingCount === 1 ? "" : "s"} missing`
    : "Incomplete album";
  node.innerHTML = `
    <div class="cover" data-cover-url="${coverUrl(trackId)}">
      <span class="cover-fallback"><strong></strong><small></small></span>
      <button class="cover-play" aria-label="Play ${album.title}">▶</button>
      ${album.incomplete ? `<span class="incomplete-album" role="img" aria-label="${incompleteLabel}" title="${incompleteLabel}"></span>` : ""}
    </div>
    <h3>${album.title}</h3><p>${album.artist}${album.year ? ` · ${album.year}` : ""}</p>
    <a class="card-download" href="/api/download-album?id=${encodeURIComponent(album.id)}" download>↓ Download album</a>`;
  const fallback = node.querySelector(".cover-fallback");
  fallback.querySelector("strong").textContent = album.artist || "Unknown artist";
  fallback.querySelector("small").textContent = album.title || "Unknown album";
  if (!lazyCover) loadAlbumCover(node.querySelector(".cover"));
  node.addEventListener("click", (event) => {
    if (event.target.closest(".card-download")) return;
    if (event.target.closest(".cover-play")) playTrackIds(album.trackIds, 0, album, node);
    else openAlbum(album);
  });
  return node;
}

function openAlbum(album) {
  state.albumPreview = null;
  state.album = album;
  $("#dialog-play").textContent = "▶ Play album";
  $("#dialog-play").classList.remove("hidden");
  $("#dialog-download").classList.remove("hidden");
  $("#dialog-edit").classList.remove("hidden");
  $("#dialog-delete").classList.remove("hidden");
  $("#dialog-cover").style.backgroundImage = `url("${coverUrl(album.trackIds[0])}")`;
  $("#dialog-title").textContent = album.title;
  $("#dialog-meta").textContent = `${album.artist}${album.year ? ` · ${album.year}` : ""} · ${album.trackIds.length} tracks · ${formatTime(album.duration)}`;
  $("#dialog-download").href = `/api/download-album?id=${encodeURIComponent(album.id)}`;
  const list = $("#dialog-tracks");
  list.replaceChildren(...album.trackIds.map((id, index) => trackRow(getTrack(id), index + 1, () => playTrackIds(album.trackIds, index, album))));
  if (!$("#album-dialog").open) $("#album-dialog").showModal();
}

function editAlbumMetadata(album) {
  const tracks = album.trackIds.map((id) => getTrack(id)).filter(Boolean);
  const list = $("#dialog-tracks");
  list.innerHTML = `
    <form id="album-metadata-form" class="album-metadata-form">
      <label>Album artist<input name="albumArtist" required></label>
      <label>Album title<input name="albumTitle" required></label>
      <div class="metadata-field-row">
        <label>Original year<input name="originalYear" inputmode="numeric" placeholder="YYYY"></label>
        <label>Genre<input name="genre"></label>
      </div>
      <fieldset><legend>Track titles</legend><div class="metadata-track-fields"></div></fieldset>
      <p class="metadata-save-note">Audio quality and embedded artwork are preserved. Originals remain recoverable in Format trash.</p>
      <div class="dialog-actions"><button class="primary" type="submit">Save metadata</button><button class="secondary metadata-cancel" type="button">Cancel</button></div>
    </form>`;
  const form = $("#album-metadata-form");
  form.elements.albumArtist.value = album.artist || "";
  form.elements.albumTitle.value = album.title || "";
  form.elements.originalYear.value = album.year || "";
  form.elements.genre.value = album.genre || "";
  const fields = form.querySelector(".metadata-track-fields");
  for (const [index, track] of tracks.entries()) {
    const label = document.createElement("label");
    label.innerHTML = `<span>${track.disc > 1 ? `${track.disc}.` : ""}${track.track || index + 1}</span><input required>`;
    const input = label.querySelector("input");
    input.value = track.title;
    input.dataset.trackId = track.id;
    fields.append(label);
  }
  $("#dialog-play").classList.add("hidden");
  $("#dialog-download").classList.add("hidden");
  $("#dialog-edit").classList.add("hidden");
  $("#dialog-delete").classList.add("hidden");
  form.querySelector(".metadata-cancel").onclick = () => openAlbum(album);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    submit.textContent = "Saving…";
    try {
      const response = await fetch(`/api/library/album-metadata?id=${encodeURIComponent(album.id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          albumArtist: form.elements.albumArtist.value,
          albumTitle: form.elements.albumTitle.value,
          originalYear: form.elements.originalYear.value,
          genre: form.elements.genre.value,
          tracks: [...fields.querySelectorAll("input")].map((input) => ({ id: input.dataset.trackId, title: input.value }))
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save metadata.");
      state.library = result.library;
      renderLibrary();
      if (!result.album) throw new Error("Metadata saved, but the updated album is awaiting library reconciliation.");
      openAlbum(result.album);
    } catch (error) {
      window.alert(error.message);
      submit.disabled = false;
      submit.textContent = "Save metadata";
    }
  };
}

async function openCatalogueAlbum(album) {
  state.albumPreview = album;
  state.album = null;
  $("#dialog-title").textContent = album.title;
  $("#dialog-meta").textContent = `${album.artist}${album.year ? ` · ${album.year}` : ""} · Loading track listing…`;
  $("#dialog-cover").style.backgroundImage = `url("${album.cover || ""}")`;
  $("#dialog-tracks").innerHTML = '<div class="catalogue-status">Loading MusicBrainz track listing…</div>';
  $("#dialog-play").textContent = "↓ Add to library";
  $("#dialog-play").classList.remove("hidden");
  $("#dialog-download").classList.add("hidden");
  $("#dialog-edit").classList.add("hidden");
  $("#dialog-delete").classList.add("hidden");
  if (!$("#album-dialog").open) $("#album-dialog").showModal();
  try {
    const response = await fetch(`/api/catalog/album?id=${encodeURIComponent(album.id)}`);
    const detail = await response.json();
    if (!response.ok) throw new Error(detail.error || "Could not load this album.");
    if (state.albumPreview?.id !== album.id) return;
    state.albumPreview = { ...album, ...detail };
    $("#dialog-meta").textContent = [detail.artist, detail.year, `${detail.tracks.length} tracks`, detail.country].filter(Boolean).join(" · ");
    $("#dialog-tracks").replaceChildren(...detail.tracks.map((track) => {
      const row = document.createElement("div");
      row.className = "track-row catalogue-track-row";
      const number = detail.tracks.some((item) => item.disc > 1) ? `${track.disc}.${track.position}` : track.position;
      row.innerHTML = `<span>${number}</span><div><strong></strong><small></small></div><small>${formatTime(track.duration)}</small>`;
      row.querySelector("strong").textContent = track.title;
      row.querySelector("div small").textContent = track.artist;
      return row;
    }));
  } catch (error) {
    $("#dialog-meta").textContent = error.message;
    $("#dialog-tracks").replaceChildren();
  }
}

function trackRow(track, number, action) {
  const row = document.createElement("div");
  row.className = "track-row";
  row.innerHTML = `<button aria-label="Play">▶</button><div><strong>${track.title}</strong><small>${track.artist} · ${track.album}</small></div><small>${formatTime(track.duration)}</small><button class="track-delete" type="button" aria-label="Delete ${track.title}" title="Move track to trash">×</button>`;
  row.querySelector("button").textContent = number || "▶";
  row.addEventListener("click", action);
  row.querySelector(".track-delete").addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!window.confirm(`Move “${track.title}” to trash?`)) return;
    try {
      await trashLibraryItem("track", track.id);
      if ($("#album-dialog").open) $("#album-dialog").close();
    } catch (error) {
      window.alert(error.message);
    }
  });
  return row;
}

async function trashLibraryItem(type, id) {
  const response = await fetch(`/api/library/trash-${type}?id=${encodeURIComponent(id)}`, { method: "POST" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Could not delete ${type}.`);
  state.library = result.library;
  renderLibrary();
  return result;
}

function renderLibrary(selectedIndex = null) {
  coverFlowCleanup();
  $("#library-count").textContent = `${state.library.albums.length} album${state.library.albums.length === 1 ? "" : "s"} · ${state.library.tracks.length} tracks`;
  const orderedAlbums = [...state.library.albums].sort((left, right) => {
    const artistDifference = artistFilingName(left.artist).localeCompare(artistFilingName(right.artist), undefined, { sensitivity: "base" });
    const yearDifference = (Number(left.year) || Number.MAX_SAFE_INTEGER) - (Number(right.year) || Number.MAX_SAFE_INTEGER);
    return artistDifference || yearDifference || left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
  });
  const flow = $("#albums");
  const firstArtistForLetter = new Map();
  const cards = orderedAlbums.map((album, index) => {
    const card = albumCard(album, { lazyCover: true });
    card.id = `library-album-${index}`;
    card.dataset.libraryIndex = String(index);
    const artist = artistFilingName(album.artist);
    const letter = /^[a-z]/i.test(artist) ? artist[0].toUpperCase() : "#";
    if (!firstArtistForLetter.has(letter)) firstArtistForLetter.set(letter, index);
    return card;
  });
  flow.replaceChildren(...cards);
  const coverObserver = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const cover = entry.target;
      loadAlbumCover(cover);
      observer.unobserve(cover);
    }
  }, { root: flow, rootMargin: "0px 200%" });
  for (const cover of flow.querySelectorAll("[data-cover-url]")) coverObserver.observe(cover);

  let cardCentres = [];
  const refreshCardMetrics = () => {
    cardCentres = cards.map((card) => card.offsetLeft + card.offsetWidth / 2);
  };
  refreshCardMetrics();
  const centreAlbum = (index, behavior = "smooth") => {
    const card = cards[index];
    if (!card) return;
    flow.scrollTo({ left: card.offsetLeft - (flow.clientWidth - card.offsetWidth) / 2, behavior });
  };
  enterLibraryAtAlbum = () => {
    const playingIndex = state.playingAlbum
      ? orderedAlbums.findIndex((album) => album.id === state.playingAlbum.id
        || (normalizedLabel(album.artist) === normalizedLabel(state.playingAlbum.artist)
          && normalizedLabel(album.title) === normalizedLabel(state.playingAlbum.title)))
      : -1;
    const targetIndex = playingIndex >= 0 ? playingIndex : Math.floor(Math.random() * cards.length);
    if (state.playingAlbum) dismissTurntable();
    refreshCardMetrics();
    centreAlbum(targetIndex, "auto");
    requestAnimationFrame(updateCoverFlow);
  };
  let animationFrame = 0;
  let activeIndex = -1;
  playSelectedLibraryAlbum = () => {
    const selectedAlbum = orderedAlbums[Math.max(0, activeIndex)];
    if (!selectedAlbum) return false;
    playTrackIds(selectedAlbum.trackIds, 0, selectedAlbum, cards[Math.max(0, activeIndex)]);
    return true;
  };
  let styledCards = new Set();
  const updateCoverFlow = () => {
    animationFrame = 0;
    const centre = flow.scrollLeft + flow.clientWidth / 2;
    const step = cardCentres[1] - cardCentres[0] || cards[0]?.offsetWidth || 1;
    const nearest = Math.max(0, Math.min(cards.length - 1, Math.round((centre - cardCentres[0]) / step)));
    const nextStyled = new Set();
    for (let index = Math.max(0, nearest - 5); index <= Math.min(cards.length - 1, nearest + 5); index += 1) {
      nextStyled.add(index);
      const card = cards[index];
      const distance = (cardCentres[index] - centre) / Math.max(card.offsetWidth, 1);
      const limited = Math.max(-3, Math.min(3, distance));
      const depth = Math.min(Math.abs(limited), 2.5);
      card.style.transform = `translate3d(0,0,${-depth * 105}px) rotateY(${-limited * 38}deg) scale(${1 - depth * .08})`;
      card.style.opacity = String(Math.max(.38, 1 - depth * .2));
      card.style.zIndex = String(20 - Math.round(depth * 5));
    }
    for (const index of styledCards) {
      if (nextStyled.has(index)) continue;
      cards[index].style.transform = "translate3d(0,0,-260px) scale(.8)";
      cards[index].style.opacity = ".2";
      cards[index].style.zIndex = "1";
    }
    if (activeIndex !== nearest) cards[activeIndex]?.classList.remove("active-cover");
    cards[nearest]?.classList.add("active-cover");
    activeIndex = nearest;
    styledCards = nextStyled;
  };
  flow.onscroll = () => {
    if (!animationFrame) animationFrame = requestAnimationFrame(updateCoverFlow);
  };
  let wheelAccumulator = 0;
  let requestedWheelIndex = -1;
  let lastWheelAt = 0;
  flow.onwheel = (event) => {
    const movement = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!movement) return;
    resumeLibraryBrowsing();
    event.preventDefault();
    flow.focus({ preventScroll: true });
    const now = performance.now();
    let direction = 0;
    if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
      wheelAccumulator += movement;
      if (Math.abs(wheelAccumulator) < 30) return;
      direction = Math.sign(wheelAccumulator);
      wheelAccumulator = 0;
    } else {
      direction = Math.sign(movement);
    }
    if (now - lastWheelAt > 350 || requestedWheelIndex < 0) requestedWheelIndex = Math.max(0, activeIndex);
    requestedWheelIndex = Math.max(0, Math.min(cards.length - 1, requestedWheelIndex + direction));
    centreAlbum(requestedWheelIndex);
    lastWheelAt = now;
  };
  flow.onkeydown = (event) => {
    if (event.key === "Enter" || event.code === "NumpadEnter") {
      event.preventDefault();
      playSelectedLibraryAlbum();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    resumeLibraryBrowsing();
    event.preventDefault();
    const activeIndex = cards.findIndex((card) => card.classList.contains("active-cover"));
    centreAlbum(Math.max(0, Math.min(cards.length - 1, activeIndex + (event.key === "ArrowRight" ? 1 : -1))));
  };
  const resizeObserver = new ResizeObserver(() => {
    refreshCardMetrics();
    if (!animationFrame) animationFrame = requestAnimationFrame(updateCoverFlow);
  });
  resizeObserver.observe(flow);
  coverFlowCleanup = () => {
    coverObserver.disconnect();
    resizeObserver.disconnect();
    cancelAnimationFrame(animationFrame);
  };
  requestAnimationFrame(updateCoverFlow);
  const jump = $("#library-alpha-jump");
  jump.replaceChildren(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = letter;
    button.disabled = !firstArtistForLetter.has(letter);
    button.setAttribute("aria-label", `Jump to artists beginning with ${letter}`);
    button.addEventListener("click", () => centreAlbum(firstArtistForLetter.get(letter)));
    return button;
  }));
  const feature = selectedIndex === null
    ? state.library.albums[Math.floor(Math.random() * state.library.albums.length)]
    : state.library.albums[selectedIndex];
  if (!feature) return null;
  $("#hero-title").textContent = feature.title;
  $("#hero-copy").textContent = `${feature.artist}${feature.year ? ` · ${feature.year}` : ""} — ${feature.genre || `${feature.trackIds.length} tracks in your local library`}`;
  $("#hero-art").style.backgroundImage = `url("${coverUrl(feature.trackIds[0])}")`;
  $("#hero-play").onclick = () => playTrackIds(feature.trackIds);
  $("#hero-info").onclick = () => openAlbum(feature);
  return feature;
}

function artistFilingName(artist) {
  return String(artist || "Unknown artist").trim().replace(/^the\s+/i, "");
}

function renderRecommendations(items) {
  $("#recommendations").replaceChildren(...items.map((item) => {
    const node = document.createElement("a");
    node.className = "card";
    node.href = "#discover";
    node.innerHTML = `<div class="cover"><strong>${item.artist}</strong></div><h3>${item.artist}</h3><p>Similar to ${item.basedOn}</p>`;
    node.addEventListener("click", (event) => {
      event.preventDefault();
      $("#search").value = item.artist;
      showPage("discover");
      search(item.artist);
    });
    return node;
  }));
}

function renderDiscoveries(items) {
  const pending = items.filter((item) => item.status === "pending");
  $("#discovery-count").textContent = `${pending.length} to review`;
  if (!pending.length) {
    const empty = document.createElement("div");
    empty.className = "discovery-empty";
    empty.textContent = "No albums waiting. The daily worker will add another suggestion tomorrow.";
    $("#daily-discoveries").replaceChildren(empty);
    return;
  }
  $("#daily-discoveries").replaceChildren(...pending.map((item) => {
    const node = document.createElement("article");
    node.className = "card discovery-card";
    node.innerHTML = `
      <div class="cover no-cover"></div>
      <h3>${item.title}</h3>
      <p>${item.artist}${item.year ? ` · ${item.year}` : ""}</p>
      <p class="discovery-origin">Via ${item.seedArtist} — ${item.seedAlbum}</p>
      <div class="discovery-actions"><button class="approve">Download album</button><button class="dismiss">Dismiss</button></div>`;
    const image = new Image();
    image.onload = () => {
      const cover = node.querySelector(".cover");
      cover.style.backgroundImage = `url("${item.cover}")`;
      cover.classList.remove("no-cover");
    };
    image.src = item.cover;
    node.addEventListener("click", (event) => {
      if (!event.target.closest("button")) openCatalogueAlbum(item);
    });
    node.querySelector(".approve").onclick = async () => {
      const response = await fetch(`/api/discoveries/approve?id=${encodeURIComponent(item.id)}`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) return window.alert(result.error || "Could not queue this album.");
      updateDownloadPanel(result);
      watchAcquisition(item.id, null);
      await loadDiscoveries();
    };
    node.querySelector(".dismiss").onclick = async () => {
      await fetch(`/api/discoveries/dismiss?id=${encodeURIComponent(item.id)}`, { method: "POST" });
      await loadDiscoveries();
    };
    return node;
  }));
}

async function loadDiscoveries() {
  const items = await fetch("/api/discoveries").then((response) => response.json());
  renderDiscoveries(items);
}

async function refreshRecommendations() {
  const button = $("#refresh-recommendations");
  button.disabled = true;
  button.textContent = "Finding…";
  try {
    const response = await fetch("/api/recommendations/refresh", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not refresh recommendations.");
    renderLibrary(result.featuredIndex);
    renderRecommendations(result.recommendations);
  } catch (error) {
    window.alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "↻ Refresh";
  }
}

async function refreshDiscovery() {
  const button = $("#refresh-discovery");
  button.disabled = true;
  button.textContent = "Finding…";
  try {
    const response = await fetch("/api/discoveries/generate?force=true", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not find another discovery.");
    await loadDiscoveries();
  } catch (error) {
    window.alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "↻ Refresh";
  }
}

let searchTimer;
let searchVersion = 0;

function localSearch(query) {
  const value = query.trim().toLocaleLowerCase();
  const includes = (...fields) => fields.some((field) => String(field || "").toLocaleLowerCase().includes(value));
  return {
    albums: state.library.albums.filter((album) => includes(album.title, album.artist, album.genre, album.year)),
    tracks: state.library.tracks.filter((track) => includes(track.title, track.artist, track.album, track.genre, track.year))
  };
}

function catalogueCard(album) {
  const node = document.createElement("a");
  node.className = "card catalogue-card";
  if (album.downloadable) {
    node.href = "#";
    node.title = `Review ${album.title}`;
    node.addEventListener("click", (event) => {
      event.preventDefault();
      openCatalogueAlbum(album);
    });
  } else {
    node.href = album.musicBrainzUrl;
    node.target = "_blank";
    node.rel = "noreferrer";
  }
  node.innerHTML = `
    <div class="cover no-cover">
      <span class="ownership ${album.downloadable ? "owned" : ""}">${album.downloadable ? "VIEW TRACKS" : "VIEW RELEASE"}</span>
    </div>
    <h3>${album.title}</h3>
    <p>${album.year || "Release year unknown"}${album.secondaryTypes.length ? ` · <span class="secondary-types">${album.secondaryTypes.join(", ")}</span>` : ""}</p>`;
  const image = new Image();
  image.onload = () => {
    const cover = node.querySelector(".cover");
    cover.style.backgroundImage = `url("${album.cover}")`;
    cover.classList.remove("no-cover");
  };
  image.src = album.cover;
  return node;
}

async function watchAcquisition(id, badge) {
  if (badge) acquisitionBadges.set(id, badge);
  await refreshDownloadManager();
}

function updateDownloadPanel(item) {
  const panel = $("#download-panel");
  panel.classList.remove("hidden", "failed");
  panel.classList.toggle("failed", item.status === "failed");
  $("#download-title").textContent = `${item.artist} — ${item.title}`;
  $("#download-percent").textContent = `${item.progress || 0}%`;
  $("#download-progress").style.width = `${item.progress || 0}%`;
  const detail = acquisitionDetail(item);
  $("#download-message").textContent = detail;
  $(".download-icon").textContent = item.status === "complete" ? "✓" : item.status === "failed" ? "!" : "↓";
}

function acquisitionDetail(item) {
  if (item.status === "queued") return `Queue position ${item.queuePosition}`;
  if (item.status === "running" && item.progress >= 100) return "Finalising album…";
  if (item.currentTrack) return `${item.message}: ${item.currentTrack}${item.provider ? ` · ${item.provider}` : ""}`;
  return item.message;
}

function acquisitionElapsed(item) {
  if (!item.startedAt) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(item.startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s elapsed`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m elapsed`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m elapsed`;
}

$("#download-dismiss").onclick = () => {
  dismissedDownloadId = lastActiveDownloadId;
  $("#download-panel").classList.add("hidden");
};

$("#clear-download-history").onclick = async () => {
  const response = await fetch("/api/acquisitions/history", { method: "DELETE" });
  if (!response.ok) return window.alert("Could not clear download history.");
  await refreshDownloadManager();
};

function renderQueueSummary(items) {
  const waiting = items.filter((item) => item.status === "queued").length;
  const active = items.find((item) => ["resolving", "running"].includes(item.status));
  $("#download-queue-count").textContent = waiting
    ? `${waiting} album${waiting === 1 ? "" : "s"} waiting${active ? " · 1 downloading" : ""}`
    : active ? "1 album downloading" : "";
}

function downloadListItem(item, queued = false) {
  const node = document.createElement("div");
  node.className = "download-item";
  const statusLabel = item.status === "complete"
    ? "COMPLETE"
    : item.status === "failed"
      ? "FAILED"
      : item.status === "cancelled"
        ? "CANCELLED"
        : item.status === "resolving"
          ? "RESOLVING"
          : item.status === "running"
            ? "DOWNLOADING"
            : `QUEUED #${item.queuePosition}`;
  node.innerHTML = `
    <span class="download-item-number">${queued ? item.queuePosition : item.status === "complete" ? "✓" : item.status === "cancelled" ? "×" : "!"}</span>
    <div><strong>${item.artist} — ${item.title}</strong><small>${item.status === "failed" ? item.message : item.finishedAt ? new Date(item.finishedAt).toLocaleString() : "Waiting to start"}</small></div>
    ${queued
      ? `<button class="download-cancel" type="button">Cancel</button>`
      : item.status === "failed"
      ? `<button class="download-retry" type="button">↻ Retry</button>`
      : `<span class="download-item-status ${item.status}">${statusLabel}</span>`}`;
  node.querySelector(".download-cancel")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    await cancelDownload(item.id);
  });
  node.querySelector(".download-retry")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Retrying…";
    try {
      const response = await fetch(`/api/acquire-album?id=${encodeURIComponent(item.id)}`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not retry this album.");
      updateDownloadPanel(result);
      renderQueueSummary(await fetch("/api/acquisitions").then((resultResponse) => resultResponse.json()));
      await refreshDownloadManager();
    } catch (error) {
      button.disabled = false;
      button.textContent = "↻ Retry";
      window.alert(error.message);
    }
  });
  return node;
}

function renderDownloads(items) {
  const active = items.find((item) => ["resolving", "running"].includes(item.status));
  const queued = items.filter((item) => item.status === "queued").sort((left, right) => left.queuePosition - right.queuePosition);
  const history = items.filter((item) => ["complete", "failed", "cancelled"].includes(item.status)).reverse();
  const activeNode = $("#active-download");
  activeNode.classList.toggle("hidden", !active);
  if (active) {
    const detail = acquisitionDetail(active);
    const elapsed = acquisitionElapsed(active);
    activeNode.innerHTML = `
      <div class="active-download-icon">↓</div>
      <div><span class="eyebrow">NOW DOWNLOADING${elapsed ? ` · ${elapsed}` : ""}</span><h3>${active.artist} — ${active.title}</h3><p>${detail}</p><div class="download-bar"><span style="width:${active.progress || 0}%"></span></div></div>
      <div class="active-download-actions"><span class="active-percent">${active.progress || 0}%</span><button class="download-cancel" type="button">Cancel</button></div>`;
    activeNode.querySelector(".download-cancel").onclick = async (event) => {
      event.currentTarget.disabled = true;
      event.currentTarget.textContent = "Cancelling…";
      await cancelDownload(active.id);
    };
  }
  $("#queue-total").textContent = `${queued.length} album${queued.length === 1 ? "" : "s"}`;
  $("#history-total").textContent = `${history.length} album${history.length === 1 ? "" : "s"}`;
  $("#download-queue").replaceChildren(...(queued.length ? queued.map((item) => downloadListItem(item, true)) : [emptyDownloadList("Nothing waiting")]));
  $("#download-history").replaceChildren(...(history.length ? history.map((item) => downloadListItem(item)) : [emptyDownloadList("No completed downloads yet")]));
}

function renderShadowAlbums(items) {
  const unpublished = items.filter((item) => !item.published)
    .sort((left, right) => left.artist.localeCompare(right.artist) || left.title.localeCompare(right.title));
  $("#shadow-total").textContent = `${unpublished.length} album${unpublished.length === 1 ? "" : "s"}`;
  $("#shadow-albums").replaceChildren(...(unpublished.length ? unpublished.map((item) => {
    const node = document.createElement("div");
    node.className = "download-item";
    const validated = item.manifest?.filter((track) => track.status === "validated" || track.status === "published").length || 0;
    const local = item.localTrackCount || 0;
    const expected = item.expectedTrackCount || item.manifest?.length || 0;
    node.innerHTML = `<span class="download-item-number">…</span><div><strong></strong><small></small></div><span class="download-item-status queued"></span>`;
    node.querySelector("strong").textContent = `${item.artist} — ${item.title}`;
    node.querySelector("small").textContent = item.lastError || `${local} local · ${validated} validated · ${expected || "?"} expected`;
    node.querySelector(".download-item-status").textContent = String(item.status || "detected").replaceAll("_", " ").toUpperCase();
    if (item.manifest?.length) {
      const details = document.createElement("details");
      details.className = "shadow-track-details";
      const summary = document.createElement("summary");
      summary.textContent = `Track manifest · ${item.manifest.filter((track) => track.status === "missing").length} missing`;
      details.append(summary);
      for (const track of item.manifest) {
        const row = document.createElement("div");
        row.className = "shadow-track-row";
        const position = document.createElement("strong");
        position.textContent = `${track.disc}.${track.position || "?"}`;
        const title = document.createElement("span");
        title.textContent = track.title;
        const status = document.createElement("small");
        status.textContent = String(track.status || "unverified").replaceAll("_", " ");
        row.append(position, title, status);
        details.append(row);
      }
      node.querySelector("div").append(details);
    }
    return node;
  }) : [emptyDownloadList("No incomplete albums")]));
}

function renderApprovals(items) {
  const section = $("#download-approvals-section");
  section.classList.toggle("hidden", items.length === 0);
  $("#approval-total").textContent = `${items.length} waiting`;
  $("#approval-notice").classList.toggle("hidden", items.length === 0 || document.querySelector("#page-downloads.active-page"));
  $("#approval-notice span").textContent = `${items.length} album${items.length === 1 ? "" : "s"} need review`;
  $("#download-approvals").replaceChildren(...items.map((item) => {
    const node = document.createElement("div");
    node.className = "download-item";
    node.innerHTML = `<span class="download-item-number">?</span><div><strong></strong><small></small></div><div class="approval-actions"><button class="review" type="button">Review album</button><button class="dismiss" type="button">Leave alone</button></div>`;
    node.querySelector("strong").textContent = `${item.artist} — ${item.title}`;
    node.querySelector("small").textContent = `${item.missingTracks.length} possible missing track${item.missingTracks.length === 1 ? "" : "s"} · ${item.reason}`;
    node.querySelector(".review").onclick = async (event) => {
      event.currentTarget.disabled = true;
      event.currentTarget.textContent = "Comparing…";
      try {
        const response = await fetch(`/api/download-approvals/review?id=${encodeURIComponent(item.id)}`, { cache: "no-store" });
        const review = await response.json();
        if (!response.ok) throw new Error(review.error || "Could not compare this album.");
        showRepairReview(review, item.id);
      } catch (error) {
        window.alert(error.message);
      } finally {
        event.currentTarget.disabled = false;
        event.currentTarget.textContent = "Review album";
      }
    };
    for (const action of ["dismiss"]) node.querySelector(`.${action}`).onclick = async (event) => {
      event.currentTarget.disabled = true;
      const response = await fetch(`/api/download-approvals/${action}?id=${encodeURIComponent(item.id)}`, { method: "POST" });
      if (!response.ok) window.alert((await response.json()).error || "Could not update approval.");
      await refreshDownloadManager();
    };
    return node;
  }));
}

function qualitySummary(track) {
  if (!track) return "No local file";
  return [track.codec?.toUpperCase(), track.bitDepth ? `${track.bitDepth}-bit` : "",
    track.sampleRate ? `${(track.sampleRate / 1000).toFixed(track.sampleRate % 1000 ? 1 : 0)} kHz` : ""]
    .filter(Boolean).join(" · ");
}

function showRepairReview(review, approvalId) {
  const dialog = $("#repair-review-dialog");
  $("#repair-review-title").textContent = `${review.album.artist} — ${review.album.title}`;
  $("#repair-review-release").innerHTML = `Compared with <a href="${review.release.url}" target="_blank" rel="noopener"></a>`;
  $("#repair-review-release a").textContent = [review.release.title, review.release.date, review.release.country].filter(Boolean).join(" · ");
  $("#repair-review-tracks").replaceChildren(...review.comparison.map((item) => {
    const row = document.createElement("div");
    row.className = "repair-review-row";
    row.innerHTML = `<strong>${item.reference.disc}.${item.reference.track}</strong><div class="reference"><strong></strong><small></small></div><div class="local"><strong></strong><small></small></div><div class="repair-track-actions"></div>`;
    row.querySelector(".reference strong").textContent = item.reference.title;
    row.querySelector(".reference small").textContent = item.reference.duration ? `MusicBrainz · ${formatTime(item.reference.duration)}` : "MusicBrainz";
    row.querySelector(".local strong").textContent = item.local?.title || "Missing locally";
    row.querySelector(".local small").textContent = item.local ? `${formatTime(item.local.duration)} · ${qualitySummary(item.local)}` : "";
    const actions = row.querySelector(".repair-track-actions");
    const addAction = (label, choice, className = "") => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.className = className;
      button.onclick = async () => {
        button.disabled = true;
        button.textContent = choice === "download" ? "Queueing…" : "Saving…";
        actions.classList.add("is-working");
        const params = new URLSearchParams({ id: approvalId, disc: item.reference.disc, track: item.reference.track, choice });
        const response = await fetch(`/api/download-approvals/track-decision?${params}`, { method: "POST" });
        const result = await response.json();
        if (!response.ok) {
          window.alert(result.error || "Could not apply track decision.");
          button.disabled = false;
          button.textContent = label;
          actions.classList.remove("is-working");
          return;
        }
        if (choice === "download") {
          actions.replaceChildren(Object.assign(document.createElement("span"), { className: "repair-status missing", textContent: "queued" }));
        } else if (choice === "keep-local") {
          actions.replaceChildren(Object.assign(document.createElement("span"), { className: "repair-status match", textContent: "keeping local" }));
        } else {
          row.querySelector(".local strong").textContent = item.reference.title;
          actions.replaceChildren(Object.assign(document.createElement("span"), { className: "repair-status match", textContent: "updated" }));
        }
        await refreshDownloadManager();
      };
      actions.append(button);
    };
    if (item.decision?.choice === "download") {
      actions.append(Object.assign(document.createElement("span"), { className: "repair-status missing", textContent: "queued" }));
    } else if (item.decision?.choice === "keep-local") {
      actions.append(Object.assign(document.createElement("span"), { className: "repair-status match", textContent: "keeping local" }));
    } else if (item.decision?.choice === "use-musicbrainz") {
      actions.append(Object.assign(document.createElement("span"), { className: "repair-status match", textContent: "MusicBrainz title applied" }));
    } else if (item.status === "missing") addAction("Download track", "download", "primary");
    else if (item.status === "mismatch" && item.mismatchKind === "title") {
      addAction("Keep local title", "keep-local");
      addAction("Use MusicBrainz title", "use-musicbrainz", "primary");
    } else {
      actions.append(Object.assign(document.createElement("span"), {
        className: `repair-status ${item.status}`, textContent: item.status === "mismatch" ? "check duration" : "match"
      }));
    }
    return row;
  }));
  const extrasTitle = $("#repair-review-extras-title");
  extrasTitle.classList.toggle("hidden", review.extras.length === 0);
  $("#repair-review-extras").replaceChildren(...review.extras.map((track) => {
    const row = document.createElement("div");
    row.className = "repair-review-row";
    row.innerHTML = `<strong>${track.disc}.${track.track}</strong><div><strong></strong><small></small></div><div></div><span class="repair-status mismatch">extra</span>`;
    row.querySelector("div strong").textContent = track.title;
    row.querySelector("div small").textContent = `${formatTime(track.duration)} · ${qualitySummary(track)}`;
    return row;
  }));
  dialog.showModal();
}

async function cancelDownload(id) {
  const response = await fetch(`/api/acquisitions/cancel?id=${encodeURIComponent(id)}`, { method: "POST" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not cancel download.");
  await refreshDownloadManager();
}

function emptyDownloadList(message) {
  const node = document.createElement("div");
  node.className = "download-list-empty";
  node.textContent = message;
  return node;
}

async function refreshDownloadManager() {
  try {
    const [items, shadowItems] = await Promise.all([fetch("/api/acquisitions").then((response) => {
      if (!response.ok) throw new Error(`Download worker returned HTTP ${response.status}`);
      return response.json();
    }), fetch("/api/shadow-albums").then((response) => {
      if (!response.ok) throw new Error(`Shadow library returned HTTP ${response.status}`);
      return response.json();
    })]);
    $("#downloader-state").innerHTML = "<i></i> Worker online";
    renderQueueSummary(items);
    renderDownloads(items);
    renderShadowAlbums(shadowItems);
    for (const [id, badge] of acquisitionBadges) {
      const item = items.find((entry) => entry.id === id);
      if (!item || ["queued", "resolving", "running"].includes(item.status)) continue;
      badge.textContent = item.status === "complete" ? "✓ ADDED TO LIBRARY" : "DOWNLOAD FAILED";
      badge.classList.toggle("owned", item.status === "complete");
      acquisitionBadges.delete(id);
    }
    const active = items.find((item) => ["resolving", "running"].includes(item.status));
    if (active) {
      clearTimeout(downloadNoticeTimer);
      if (active.id !== lastActiveDownloadId) dismissedDownloadId = null;
      lastActiveDownloadId = active.id;
      if (dismissedDownloadId !== active.id) updateDownloadPanel(active);
    } else if (lastActiveDownloadId) {
      const finished = items.find((item) => item.id === lastActiveDownloadId);
      lastActiveDownloadId = null;
      dismissedDownloadId = null;
      if (finished && ["complete", "failed", "cancelled"].includes(finished.status)) {
        updateDownloadPanel(finished);
        clearTimeout(downloadNoticeTimer);
        downloadNoticeTimer = setTimeout(() => $("#download-panel").classList.add("hidden"), finished.status === "failed" ? 8000 : 4000);
      }
    } else {
      $("#download-panel").classList.add("hidden");
    }
  } catch {
    $("#downloader-state").innerHTML = "<i></i> Worker unavailable";
  }
}

async function search(query) {
  const section = $("#search-results");
  const value = query.trim();
  if (!value) return section.classList.add("hidden");
  showPage("discover");
  section.classList.remove("hidden");
  section.scrollIntoView({ behavior: "smooth" });
  const matches = localSearch(value);
  $("#local-albums").replaceChildren(...matches.albums.map(albumCard));
  $("#results").replaceChildren(...matches.tracks.map((track) => trackRow(track, 0, () => playTrackIds([track.id]))));
  $("#local-albums-heading").textContent = `${matches.albums.length} ALBUM${matches.albums.length === 1 ? "" : "S"} IN YOUR LIBRARY`;
  $("#local-tracks-heading").textContent = `${matches.tracks.length} SONG${matches.tracks.length === 1 ? "" : "S"} IN YOUR LIBRARY`;
  $("#local-albums-wrap").classList.toggle("hidden", matches.albums.length === 0);
  $("#local-matches-wrap").classList.toggle("hidden", matches.tracks.length === 0);
  $("#catalogue-status").textContent = "Searching the artist catalogue…";
  $("#catalogue-albums").replaceChildren();
  $("#catalogue-title").textContent = value;
  $("#catalogue-meta").textContent = "";
  const version = ++searchVersion;
  try {
    const data = await fetch(`/api/catalog/search?q=${encodeURIComponent(value)}`).then((response) => {
      if (!response.ok) throw new Error("Catalogue search failed");
      return response.json();
    });
    if (version !== searchVersion) return;
    if (!data.artist) {
      $("#catalogue-status").textContent = "No matching artist found.";
      return;
    }
    $("#catalogue-title").textContent = data.artist.name;
    $("#catalogue-meta").textContent = [data.artist.country, data.artist.disambiguation].filter(Boolean).join(" · ");
    $("#catalogue-status").textContent = `${data.albums.length} album release${data.albums.length === 1 ? "" : "s"} · ${data.albums.filter((album) => album.owned).length} in your library`;
    $("#catalogue-albums").replaceChildren(...data.albums.map(catalogueCard));
  } catch {
    if (version === searchVersion) $("#catalogue-status").textContent = "The external album catalogue is temporarily unavailable.";
  }
}

$("#dialog-play").onclick = () => {
  if (state.albumPreview) {
    const album = state.albumPreview;
    const button = $("#dialog-play");
    button.disabled = true;
    button.textContent = "QUEUING…";
    fetch(`/api/acquire-album?id=${encodeURIComponent(album.id)}`, { method: "POST" })
      .then(async (response) => ({ response, result: await response.json() }))
      .then(({ response, result }) => {
        if (!response.ok) throw new Error(result.error || "Could not queue this album.");
        updateDownloadPanel(result);
        watchAcquisition(album.id, null);
        $("#album-dialog").close();
      })
      .catch((error) => window.alert(error.message))
      .finally(() => { button.disabled = false; button.textContent = "↓ Add to library"; });
    return;
  }
  const album = state.album;
  $("#album-dialog").close();
  playTrackIds(album.trackIds, 0, album);
};
$("#dialog-delete").onclick = async () => {
  const album = state.album;
  if (!window.confirm(`Move “${album.title}” and all ${album.trackIds.length} tracks to trash?`)) return;
  try {
    await trashLibraryItem("album", album.id);
    $("#album-dialog").close();
  } catch (error) {
    window.alert(error.message);
  }
};
$("#dialog-edit").onclick = () => {
  if (state.album) editAlbumMetadata(state.album);
};
$("#album-dialog .dialog-close").onclick = () => $("#album-dialog").close();
$("#album-dialog").addEventListener("close", () => {
  state.albumPreview = null;
  $("#dialog-play").textContent = "▶ Play album";
  $("#dialog-play").classList.remove("hidden");
  $("#dialog-download").classList.remove("hidden");
  $("#dialog-edit").classList.remove("hidden");
  $("#dialog-delete").classList.remove("hidden");
});
$("#repair-review-dialog .dialog-close").onclick = () => $("#repair-review-dialog").close();
$("#repair-review-dialog").addEventListener("click", (event) => {
  const dialog = event.currentTarget;
  const bounds = dialog.getBoundingClientRect();
  const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  if (outside) dialog.close();
});
$("#album-dialog").addEventListener("click", (event) => {
  const dialog = event.currentTarget;
  const bounds = dialog.getBoundingClientRect();
  const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  if (outside) dialog.close();
});
$("#toggle").onclick = togglePlayback;
$("#previous").onclick = previousTrack;
$("#next").onclick = nextTrack;
$("#volume").oninput = (event) => { audio.volume = event.target.value; };
$("#seek").oninput = (event) => { audio.currentTime = audio.duration * event.target.value / 100; };
$("#search").oninput = (event) => {
  clearTimeout(searchTimer);
  const value = event.target.value;
  if (!value.trim()) {
    searchVersion++;
    $("#search-results").classList.add("hidden");
    return;
  }
  searchTimer = setTimeout(() => search(value), 450);
};
$("#rescan").onclick = async () => {
  const button = $("#rescan");
  const status = $("#rescan-status");
  button.disabled = true;
  button.textContent = "…";
  status.textContent = "Scanning…";
  status.classList.remove("error");
  try {
    const response = await fetch("/api/rescan", { method: "POST" });
    if (!response.ok) throw new Error("Library scan failed");
    state.library = await response.json();
    const bootstrapResponse = await fetch("/api/bootstrap");
    if (!bootstrapResponse.ok) throw new Error("Could not refresh the library view");
    const bootstrap = await bootstrapResponse.json();
    state.library = bootstrap.library;
    renderLibrary(bootstrap.featuredIndex);
    renderRecommendations(bootstrap.recommendations);
    status.textContent = "Library updated";
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = "↻";
  }
};
$("#refresh-recommendations").onclick = refreshRecommendations;
$("#refresh-discovery").onclick = refreshDiscovery;
$("#acquire-similar").onclick = async () => {
  const button = $("#acquire-similar");
  button.disabled = true;
  button.textContent = "Finding album…";
  try {
    const response = await fetch("/api/discoveries/acquire-random", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not queue a similar album.");
    updateDownloadPanel(result);
    watchAcquisition(result.id, null);
    renderQueueSummary(await fetch("/api/acquisitions").then((value) => value.json()));
  } finally {
    button.disabled = false;
    button.textContent = "↓ Download similar album";
  }
};
document.addEventListener("keydown", (event) => {
  const libraryFlow = $("#albums");
  const editingText = event.target instanceof HTMLInputElement
    || event.target instanceof HTMLTextAreaElement
    || event.target?.isContentEditable;
  if (!editingText
    && !$("#album-dialog").open
    && document.querySelector("#page-library.active-page")
    && document.activeElement !== libraryFlow
    && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    libraryFlow.onkeydown?.(event);
    return;
  }
  if (event.key === "/" && document.activeElement !== $("#search")) {
    event.preventDefault();
    $("#search").focus();
  }
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#turntable-stage").classList.contains("active")) {
    resumeLibraryBrowsing();
    $("#albums").focus({ preventScroll: true });
    return;
  }
  if (event.key !== "Enter" && event.code !== "Enter" && event.code !== "NumpadEnter") return;
  if (!document.querySelector("#page-library.active-page") || $("#album-dialog").open) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target?.isContentEditable) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  playSelectedLibraryAlbum();
}, { capture: true });
window.addEventListener("keydown", (event) => {
  const typing = event.target instanceof HTMLInputElement
    || event.target instanceof HTMLTextAreaElement
    || event.target?.isContentEditable;
  if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if ((key === " " || key === "k") && !event.repeat) {
    event.preventDefault();
    togglePlayback();
  } else if (key === "j" && !event.repeat) {
    event.preventDefault();
    previousTrack();
  } else if (key === "l" && !event.repeat) {
    event.preventDefault();
    nextTrack();
  } else if (key === "m" && !event.repeat) {
    event.preventDefault();
    audio.muted = !audio.muted;
  } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    audio.muted = false;
    audio.volume = Math.max(0, Math.min(1, audio.volume + (event.key === "ArrowUp" ? .05 : -.05)));
    $("#volume").value = String(audio.volume);
  } else if (/^[0-9]$/.test(key) && Number.isFinite(audio.duration) && audio.duration > 0) {
    event.preventDefault();
    audio.currentTime = audio.duration * Number(key) / 10;
  } else if ((event.key === "Home" || event.key === "End") && Number.isFinite(audio.duration) && audio.duration > 0) {
    event.preventDefault();
    audio.currentTime = event.key === "Home" ? 0 : Math.max(0, audio.duration - .1);
  } else if (key === "f" && !event.repeat) {
    event.preventDefault();
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  }
}, { capture: true });
audio.onplay = () => {
  $("#toggle").textContent = "Ⅱ";
  $("#turntable-stage").classList.remove("paused");
  scheduleTurntableReturn();
};
audio.onpause = () => {
  $("#toggle").textContent = "▶";
  $("#turntable-stage").classList.add("paused");
  clearTimeout(libraryIdleTimer);
};
audio.ontimeupdate = () => {
  $("#elapsed").textContent = formatTime(audio.currentTime);
  $("#duration").textContent = formatTime(audio.duration);
  $("#seek").value = audio.duration ? audio.currentTime / audio.duration * 100 : 0;
};
audio.onended = () => {
  if (state.index < state.queue.length - 1) { state.index++; loadCurrent(true); }
  else dismissTurntable();
};
for (const eventName of ["pointerdown", "wheel", "keydown"]) {
  window.addEventListener(eventName, () => {
    if (document.querySelector("#page-library.active-page") && !$("#turntable-stage").classList.contains("active")) scheduleTurntableReturn();
  }, { passive: eventName === "wheel" });
}
audio.volume = .8;

async function loadBootstrap(attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch("/api/bootstrap", { cache: "no-store" });
      if (!response.ok) throw new Error(`Library service returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

let bootstrap;
try {
  bootstrap = await loadBootstrap();
} catch (error) {
  $("#library-count").textContent = "Library unavailable";
  $("#hero-title").textContent = "Could not load your library";
  $("#hero-copy").textContent = `${error.message}. Refresh to try again.`;
  $("#rescan-status").textContent = "Connection failed";
  $("#rescan-status").classList.add("error");
  setTimeout(() => location.reload(), 5000);
  throw error;
}
state.library = bootstrap.library;
lookupRateLimit = bootstrap.lookupRateLimit || lookupRateLimit;
renderRateLimitClock();
renderLibrary(bootstrap.featuredIndex);
renderRecommendations(bootstrap.recommendations);
renderDiscoveries(bootstrap.discoveries);
showPage(location.hash.slice(1), false);
{
  const activeAcquisitions = bootstrap.acquisitions;
  renderQueueSummary(activeAcquisitions);
  renderDownloads(activeAcquisitions);
  const visibleAcquisition = activeAcquisitions.find((item) => ["running", "resolving"].includes(item.status))
    || null;
  if (visibleAcquisition) {
    lastActiveDownloadId = visibleAcquisition.id;
    updateDownloadPanel(visibleAcquisition);
  }
}
if (bootstrap.libraryScan.inProgress) {
  $("#library-count").textContent = "Scanning…";
  void (async () => {
    let refreshed = bootstrap;
    while (refreshed.libraryScan.inProgress) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      refreshed = await loadBootstrap();
    }
    if (refreshed.library.updatedAt !== state.library.updatedAt) {
      state.library = refreshed.library;
      renderLibrary(refreshed.featuredIndex);
      renderRecommendations(refreshed.recommendations);
    }
    $("#library-count").textContent = `${state.library.albums.length} albums · ${state.library.tracks.length} tracks`;
  })().catch(() => {
    $("#library-count").textContent = "Library scan status unavailable";
  });
}
setInterval(refreshDownloadManager, 2500);
setInterval(renderRateLimitClock, 1000);
setInterval(refreshRateLimitClock, 5000);
