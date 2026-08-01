const state = { library: null, queue: [], index: -1, album: null };
const $ = (selector) => document.querySelector(selector);
const audio = $("#audio");
const pages = new Set(["discover", "library", "downloads"]);
let lookupRateLimit = { active: false, until: null, remainingMs: 0 };

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
  document.querySelectorAll(".page").forEach((node) => node.classList.toggle("active-page", node.id === `page-${page}`));
  document.querySelectorAll("[data-page-link]").forEach((node) => node.classList.toggle("active", node.dataset.pageLink === page));
  if (updateHash && location.hash !== `#${page}`) history.pushState(null, "", `#${page}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

window.addEventListener("hashchange", () => showPage(location.hash.slice(1), false));

const formatTime = (seconds) => {
  if (!Number.isFinite(seconds)) return "0:00";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
};
const coverUrl = (trackId) => `/api/cover?id=${encodeURIComponent(trackId)}`;
const getTrack = (id) => state.library.tracks.find((track) => track.id === id);

function playTrackIds(ids, start = 0) {
  state.queue = ids;
  state.index = start;
  loadCurrent(true);
}

function loadCurrent(autoplay = false) {
  const track = getTrack(state.queue[state.index]);
  if (!track) return;
  audio.src = `/api/audio?id=${encodeURIComponent(track.id)}`;
  $("#player-title").textContent = track.title;
  $("#player-artist").textContent = track.artist;
  $("#player-cover").style.backgroundImage = `url("${coverUrl(track.id)}")`;
  if (autoplay) audio.play();
}

function albumCard(album) {
  const trackId = album.trackIds[0];
  const node = document.createElement("article");
  node.className = "card";
  const missingCount = album.missingTracks?.length || 0;
  const incompleteLabel = missingCount
    ? `Incomplete album: ${missingCount} track${missingCount === 1 ? "" : "s"} missing`
    : "Incomplete album";
  node.innerHTML = `
    <div class="cover" style="background-image:url('${coverUrl(trackId)}')">
      <button class="cover-play" aria-label="Play ${album.title}">▶</button>
      ${album.incomplete ? `<span class="incomplete-album" role="img" aria-label="${incompleteLabel}" title="${incompleteLabel}"></span>` : ""}
    </div>
    <h3>${album.title}</h3><p>${album.artist}${album.year ? ` · ${album.year}` : ""}</p>
    <a class="card-download" href="/api/download-album?id=${encodeURIComponent(album.id)}" download>↓ Download album</a>`;
  node.addEventListener("click", (event) => {
    if (event.target.closest(".card-download")) return;
    if (event.target.closest(".cover-play")) playTrackIds(album.trackIds);
    else openAlbum(album);
  });
  return node;
}

function openAlbum(album) {
  state.album = album;
  $("#dialog-cover").style.backgroundImage = `url("${coverUrl(album.trackIds[0])}")`;
  $("#dialog-title").textContent = album.title;
  $("#dialog-meta").textContent = `${album.artist}${album.year ? ` · ${album.year}` : ""} · ${album.trackIds.length} tracks · ${formatTime(album.duration)}`;
  $("#dialog-download").href = `/api/download-album?id=${encodeURIComponent(album.id)}`;
  const list = $("#dialog-tracks");
  list.replaceChildren(...album.trackIds.map((id, index) => trackRow(getTrack(id), index + 1, () => playTrackIds(album.trackIds, index))));
  $("#album-dialog").showModal();
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
  $("#library-count").textContent = `${state.library.albums.length} album${state.library.albums.length === 1 ? "" : "s"} · ${state.library.tracks.length} tracks`;
  $("#albums").replaceChildren(...state.library.albums.map(albumCard));
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
    node.title = `Add ${album.title} to your library`;
    node.addEventListener("click", async (event) => {
      event.preventDefault();
      const badge = node.querySelector(".ownership");
      badge.textContent = "FINDING RELEASE…";
      const response = await fetch(`/api/acquire-album?id=${encodeURIComponent(album.id)}`, { method: "POST" });
      const result = await response.json();
      badge.textContent = response.ok ? (result.status === "queued" ? `QUEUED #${result.queuePosition}` : "DOWNLOADING…") : (result.error || "FAILED");
      badge.classList.toggle("owned", response.ok);
      if (response.ok) {
        updateDownloadPanel(result);
        watchAcquisition(album.id, badge);
      }
    });
  } else {
    node.href = album.musicBrainzUrl;
    node.target = "_blank";
    node.rel = "noreferrer";
  }
  node.innerHTML = `
    <div class="cover no-cover">
      <span class="ownership ${album.downloadable ? "owned" : ""}">${album.downloadable ? "↓ ADD TO LIBRARY" : "VIEW RELEASE"}</span>
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
  const timer = setInterval(async () => {
    const items = await fetch("/api/acquisitions").then((response) => response.json());
    renderQueueSummary(items);
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    updateDownloadPanel(item);
    if (["queued", "resolving", "running"].includes(item.status)) return;
    clearInterval(timer);
    if (badge) {
      badge.textContent = item.status === "complete" ? "✓ ADDED TO LIBRARY" : "DOWNLOAD FAILED";
      badge.classList.toggle("owned", item.status === "complete");
    }
  }, 3000);
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

$("#download-dismiss").onclick = () => $("#download-panel").classList.add("hidden");

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
    const items = await fetch("/api/acquisitions").then((response) => {
      if (!response.ok) throw new Error(`Download worker returned HTTP ${response.status}`);
      return response.json();
    });
    $("#downloader-state").innerHTML = "<i></i> Worker online";
    renderQueueSummary(items);
    renderDownloads(items);
    const visible = items.find((item) => ["resolving", "running"].includes(item.status))
      || items.find((item) => item.status === "queued")
      || items.at(-1);
    if (visible && !$("#download-panel").classList.contains("hidden")) updateDownloadPanel(visible);
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

$("#dialog-play").onclick = () => playTrackIds(state.album.trackIds);
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
$(".dialog-close").onclick = () => $("#album-dialog").close();
$("#toggle").onclick = () => audio.paused ? audio.play() : audio.pause();
$("#previous").onclick = () => { if (state.index > 0) { state.index--; loadCurrent(true); } };
$("#next").onclick = () => { if (state.index < state.queue.length - 1) { state.index++; loadCurrent(true); } };
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
  if (event.key === "/" && document.activeElement !== $("#search")) {
    event.preventDefault();
    $("#search").focus();
  }
});
audio.onplay = () => { $("#toggle").textContent = "Ⅱ"; };
audio.onpause = () => { $("#toggle").textContent = "▶"; };
audio.ontimeupdate = () => {
  $("#elapsed").textContent = formatTime(audio.currentTime);
  $("#duration").textContent = formatTime(audio.duration);
  $("#seek").value = audio.duration ? audio.currentTime / audio.duration * 100 : 0;
};
audio.onended = () => {
  if (state.index < state.queue.length - 1) { state.index++; loadCurrent(true); }
};
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
  throw error;
}
state.library = bootstrap.library;
lookupRateLimit = bootstrap.lookupRateLimit || lookupRateLimit;
renderRateLimitClock();
renderLibrary(bootstrap.featuredIndex);
renderRecommendations(bootstrap.recommendations);
renderDiscoveries(bootstrap.discoveries);
while (bootstrap.libraryScan.inProgress) {
  $("#library-count").textContent = "Scanning…";
  await new Promise((resolve) => setTimeout(resolve, 750));
  bootstrap = await loadBootstrap();
}
if (bootstrap.library.updatedAt !== state.library.updatedAt) {
  state.library = bootstrap.library;
  renderLibrary(bootstrap.featuredIndex);
  renderRecommendations(bootstrap.recommendations);
}
showPage(location.hash.slice(1), false);
{
  const activeAcquisitions = bootstrap.acquisitions;
  renderQueueSummary(activeAcquisitions);
  renderDownloads(activeAcquisitions);
  const visibleAcquisition = activeAcquisitions.find((item) => ["running", "resolving"].includes(item.status))
    || activeAcquisitions.find((item) => item.status === "queued")
    || activeAcquisitions.at(-1);
  if (visibleAcquisition) {
    updateDownloadPanel(visibleAcquisition);
    if (["queued", "resolving", "running"].includes(visibleAcquisition.status)) watchAcquisition(visibleAcquisition.id, null);
  }
}
setInterval(refreshDownloadManager, 2500);
setInterval(renderRateLimitClock, 1000);
setInterval(refreshRateLimitClock, 5000);
