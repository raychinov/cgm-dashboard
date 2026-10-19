import { DexcomError, getReadings, getCreds, setCreds, clearCreds, invalidateSession } from "./dexcom-client.js";
import { bandFor, colorHex, formatDelta, formatGlucose, graphRange, nextFetchDelay, nextLagEstimate, normalizeReadings, summarize, trendArrow } from "./display.js";

const CONFIG = {
  units: "mmol",
  thresholds: { urgentLow: 70, low: 81, high: 162, urgentHigh: 180 },
  readingIntervalMs: 300_000,
  readingLagMs: 10_000,
  retryMs: 5_000,
  overdueWindowMs: 180_000,
  refreshMs: 60_000,
  nightRefreshMs: 120_000,
  loggedOutRetryMs: 3_600_000,
  hintMs: 30_000,
  nightStartHour: 22,
  nightEndHour: 7,
  staleMinutes: 15,
  graphHours: 3,
  minutes: 180,
  maxCount: 36,
};
const LAG_KEY = "cgm.lag";
const SEEN_KEY = "cgm.seen";

const $ = (id) => document.getElementById(id);
const $glucose = $("glucose"), $trend = $("trend"), $meta = $("meta"), $banner = $("banner");
const $canvas = $("graph"), $hint = $("fullscreen-hint"), $setup = $("setup"), $nosleep = $("nosleep");
const $form = $("setup-form"), $u = $("setup-username"), $p = $("setup-password");
const $server = $("setup-server"), $save = $("setup-save"), $err = $("setup-error");
const $clockTime = $("clock-time"), $clockDate = $("clock-date");
const $clock = $("clock"), $readingArea = $("reading-area"), $glucoseRow = $("glucose-row");

let readings = [];
let seen = loadSeen();
let seenThisSession = false;
let lagMs = loadLag();
let errorText = "";
let refreshTimer = null;
let running = false;
let run = 0;
let loggedOut = false;
let loggedOutTimer = null;
let hintTimer = null;

function loadLag() {
  const stored = Number(localStorage.getItem(LAG_KEY));
  return localStorage.getItem(LAG_KEY) !== null && !Number.isNaN(stored) ? stored : CONFIG.readingLagMs;
}

function loadSeen() {
  try {
    const stored = JSON.parse(localStorage.getItem(SEEN_KEY));
    return stored && typeof stored.ts === "number" && typeof stored.at === "number" ? stored : null;
  } catch {
    return null;
  }
}

function noteSeen(now) {
  if (!readings.length) return;
  const newest = readings[readings.length - 1].ts;
  if (seen && newest <= seen.ts) return;
  if (seenThisSession) {
    lagMs = nextLagEstimate(lagMs, now - newest);
    localStorage.setItem(LAG_KEY, String(lagMs));
  }
  seen = { ts: newest, at: now };
  seenThisSession = true;
  localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
}

function seenAtForLatest() {
  return readings.length && seen && seen.ts === readings[readings.length - 1].ts ? seen.at : NaN;
}

function showSetupError(msg) { $err.textContent = msg; $err.style.display = "block"; }
function hideSetupError() { $err.style.display = "none"; }

function describeFailure(err) {
  if (err instanceof DexcomError) {
    if (err.isLocked) return "Dexcom locked the account after too many failed logins. Wait 15 minutes, then try again.";
    if (err.isAuthError) return "Dexcom rejected the login. Check the username, password and region.";
    if (err.isPaused) return `Logins paused for ${Math.ceil(err.retryInMs / 60_000)} min after a Dexcom error.`;
    return `Dexcom error: ${err.code}`;
  }
  return "Could not reach Dexcom. Check the network connection.";
}

function shortFailure(err) {
  if (err.isLocked) return "account locked, wait 15 min";
  if (err.isAuthError) return "Dexcom rejected the login";
  return `Dexcom error: ${err.code}`;
}

function needsTapToStart() {
  return navigator.maxTouchPoints > 0 || /Mobi|Android/i.test(navigator.userAgent);
}

function enterFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement) return;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
}

function showHint() {
  if (!needsTapToStart()) return;
  $hint.classList.remove("hidden");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(hideHint, CONFIG.hintMs);
}
function hideHint() { clearTimeout(hintTimer); $hint.classList.add("hidden"); }

function onGesture() {
  if (!running && !loggedOut) return;
  if (loggedOut) { retryLogin(); return; }
  enterFullscreen();
  keepAwake();
  hideHint();
}
document.addEventListener("click", onGesture);
document.addEventListener("touchend", onGesture, { passive: true });

async function submitCreds(e) {
  e.preventDefault();
  const username = $u.value.trim();
  const password = $p.value;
  const server = $server.value;
  if (!username || !password) { showSetupError("Username and password required"); return; }
  hideSetupError();
  $save.disabled = true;
  $save.textContent = "Connecting...";
  try {
    const creds = { username, password, server };
    clearCreds();
    invalidateSession();
    const data = await getReadings({ ...creds, minutes: CONFIG.minutes, maxCount: CONFIG.maxCount });
    if (!data || data.length === 0) {
      showSetupError("Connected, but Dexcom returned no readings. Use the account signed in on the phone with the sensor, not a follower's. In the Dexcom app, Connections, Share must be on with at least one follower.");
      return;
    }
    setCreds(creds);
    readings = normalizeReadings(data);
    noteSeen(Date.now());
    clearError();
    updateDisplay();
    $setup.classList.add("hidden");
    startApp();
    enterFullscreen();
    keepAwake();
  } catch (err) {
    clearCreds();
    showSetupError(describeFailure(err));
  } finally {
    $save.disabled = false;
    $save.textContent = "Connect";
  }
}
$form.addEventListener("submit", submitCreds);

async function fetchReadings() {
  const creds = getCreds();
  if (!creds) return false;
  const thisRun = run;
  try {
    const data = await getReadings({ ...creds, minutes: CONFIG.minutes, maxCount: CONFIG.maxCount });
    if (thisRun !== run) return false;
    const fresh = normalizeReadings(data);
    if (fresh.length) {
      readings = fresh;
      noteSeen(Date.now());
    }
    clearError();
    updateDisplay();
    return true;
  } catch (err) {
    if (thisRun !== run) return false;
    console.error("Fetch error:", err);
    if (err instanceof DexcomError && err.isAuthError) {
      showLoggedOut(err);
      return false;
    }
    showError(err instanceof DexcomError && err.isPaused ? `NO DATA · logins paused ${Math.ceil(err.retryInMs / 60_000)} min` : "NO DATA");
    renderMeta();
    return false;
  }
}

function showLoggedOut(err) {
  stopApp();
  loggedOut = true;
  hideHint();
  showError(`LOGGED OUT · ${shortFailure(err)} · tap to retry`);
  renderMeta();
  if (err.code === "SSO_InternalError") loggedOutTimer = setTimeout(retryLogin, CONFIG.loggedOutRetryMs);
}

function retryLogin() {
  if (!loggedOut) return;
  loggedOut = false;
  clearTimeout(loggedOutTimer);
  clearError();
  startApp(true);
}

function fitBlock(area, parts) {
  if (!area.clientWidth || !area.clientHeight) return;
  area.style.fontSize = "100px";
  const box = area.getBoundingClientRect();
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const el of parts) {
    const r = el.getBoundingClientRect();
    left = Math.min(left, r.left); right = Math.max(right, r.right);
    top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom);
  }
  const scale = Math.min(box.width / (right - left), box.height / (bottom - top)) * 0.9;
  area.style.fontSize = Math.max(16, Math.floor(100 * scale)) + "px";
}

function fitText() {
  fitBlock($readingArea, [$glucoseRow, $meta]);
  fitBlock($clock, [$clockTime, $clockDate]);
}

function renderBanner(summary) {
  const stale = Boolean(summary && summary.stale);
  document.body.classList.toggle("stale", stale);
  if ($banner.className === "error") {
    $banner.textContent = stale ? `${errorText} · last reading ${summary.ageMin} min ago` : errorText;
    return;
  }
  if (stale) {
    $banner.textContent = "STALE (" + summary.ageMin + " min)";
    $banner.className = "stale";
  } else if ($banner.className === "stale") {
    $banner.className = "";
    $banner.textContent = "";
  }
}

function renderMeta() {
  const summary = summarize(readings, Date.now(), CONFIG.staleMinutes, seenAtForLatest());
  if (summary) {
    const deltaStr = summary.delta === null ? "" : formatDelta(summary.delta, CONFIG.units) + " · ";
    $meta.textContent = deltaStr + summary.ageMin + " min ago";
  } else {
    $meta.textContent = "No readings";
  }
  renderBanner(summary);
  fitText();
  drawGraph();
}

function updateDisplay() {
  if (!readings.length) {
    $glucose.textContent = "---";
    $glucose.className = "";
    $trend.textContent = "";
    $trend.className = "";
    renderMeta();
    return;
  }
  const latest = readings[readings.length - 1];
  const band = "color-" + bandFor(latest.mgdl, CONFIG.thresholds);
  $glucose.textContent = formatGlucose(latest.mgdl, CONFIG.units);
  $glucose.className = band;
  $trend.textContent = trendArrow(latest.trend);
  $trend.className = band;
  renderMeta();
}

function drawGraph() {
  const container = $canvas.parentElement, w = container.clientWidth, h = container.clientHeight;
  if (w === 0 || h === 0) return;
  const dpr = window.devicePixelRatio || 1;
  $canvas.width = Math.round(w * dpr);
  $canvas.height = Math.round(h * dpr);
  const ctx = $canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const pad = { top: 8, right: 8, bottom: 4, left: 36 }, gw = w - pad.left - pad.right, gh = h - pad.top - pad.bottom;
  const now = Date.now(), xStart = now - CONFIG.graphHours * 3_600_000;
  const visible = readings.filter((r) => r.ts >= xStart);
  const { yMin, yMax } = graphRange(visible, CONFIG.thresholds);
  const yPos = (mgdl) => pad.top + gh * (1 - (mgdl - yMin) / (yMax - yMin));
  const xPos = (ts) => pad.left + gw * ((ts - xStart) / (now - xStart));
  const t = CONFIG.thresholds;
  const band = (from, to, fill) => { ctx.fillStyle = fill; ctx.fillRect(pad.left, yPos(to), gw, yPos(from) - yPos(to)); };
  band(yMin, t.urgentLow, "rgba(139,0,0,0.08)");
  band(t.urgentLow, t.low, "rgba(139,128,0,0.06)");
  band(t.low, t.high, "rgba(0,128,0,0.08)");
  band(t.high, t.urgentHigh, "rgba(139,128,0,0.06)");
  band(t.urgentHigh, yMax, "rgba(139,0,0,0.08)");
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  for (const val of [t.low, t.high]) { ctx.beginPath(); ctx.moveTo(pad.left, yPos(val)); ctx.lineTo(pad.left + gw, yPos(val)); ctx.stroke(); }
  ctx.setLineDash([]);
  if (visible.length < 2) return;
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  visible.forEach((r, i) => { const x = xPos(r.ts), y = yPos(r.mgdl); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
  for (const r of visible) {
    ctx.fillStyle = colorHex(r.mgdl, t);
    ctx.beginPath();
    ctx.arc(xPos(r.ts), yPos(r.mgdl), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  const ticks = CONFIG.units === "mmol" ? [3, 6, 9, 12] : [54, 108, 162, 216];
  ctx.font = "11px -apple-system,sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#777";
  for (const val of ticks) {
    const mgdl = CONFIG.units === "mmol" ? val * 18 : val;
    if (mgdl < yMin || mgdl > yMax) continue;
    ctx.fillText(String(val), pad.left - 4, yPos(mgdl));
  }
}

function showError(msg) { errorText = msg; $banner.textContent = msg; $banner.className = "error"; }
function clearError() { if ($banner.className === "error") { errorText = ""; $banner.className = ""; $banner.textContent = ""; } }

const SILENT_MP4 = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMqbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAHNbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABeG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAThzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2Mi4xMS4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwArZHsBEAAADAAQAAAMAEDxImSABAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABPgAAAAAAAAABhzdHRzAAAAAAAAAAEAAAACAAAgAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAACAAAAAQAAABxzdHN6AAAAAAAAAAAAAAACAAACcgAAAAoAAAAUc3RjbwAAAAAAAAABAAADWgAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjIuMy4xMDAAAAAIZnJlZQAAAoRtZGF0AAACXwYF//9b3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTIga2V5aW50X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9MiByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAALZYiEBTyYoAA/v4AAAAAGQZo4CXqA";

let wakeLock = null;
function requestWakeLock() {
  if (!navigator.wakeLock || wakeLock || document.visibilityState !== "visible") return;
  navigator.wakeLock.request("screen").then((lock) => {
    wakeLock = lock;
    lock.addEventListener("release", () => {
      wakeLock = null;
      if (running) setTimeout(requestWakeLock, 1000);
    });
  }).catch(() => {});
}

function keepAwake() {
  requestWakeLock();
  if (!$nosleep.getAttribute("src")) $nosleep.setAttribute("src", SILENT_MP4);
  $nosleep.play().catch(() => {});
}

function isNightTime() {
  const h = new Date().getHours();
  const { nightStartHour: start, nightEndHour: end } = CONFIG;
  return start > end ? h >= start || h < end : h >= start && h < end;
}
function updateNightMode() { document.body.classList.toggle("night-mode", isNightTime()); }
function getRefreshMs() { return isNightTime() ? CONFIG.nightRefreshMs : CONFIG.refreshMs; }

let inflight = null;
function refresh() {
  if (inflight) return inflight;
  clearTimeout(refreshTimer);
  inflight = fetchReadings().then((ok) => {
    inflight = null;
    if (running) scheduleNextFetch(!ok);
  });
  return inflight;
}
function scheduleNextFetch(afterFailure = false) {
  clearTimeout(refreshTimer);
  const fallbackMs = getRefreshMs();
  const delay = afterFailure ? fallbackMs : nextFetchDelay(readings, Date.now(), { ...CONFIG, readingLagMs: lagMs, fallbackMs });
  refreshTimer = setTimeout(refresh, delay);
}
function startApp(fetchNow = false) {
  run++;
  running = true;
  keepAwake();
  showHint();
  if (readings.length && !fetchNow) scheduleNextFetch(); else refresh();
}
function stopApp() { run++; running = false; clearTimeout(refreshTimer); }

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !running) return;
  keepAwake();
  refresh();
});

const $xLabels = $("x-labels");
$xLabels.textContent = "";
for (let h = CONFIG.graphHours; h >= 0; h--) {
  const label = document.createElement("span");
  label.textContent = h ? `-${h}h` : "now";
  $xLabels.appendChild(label);
}

function tick() {
  const now = new Date();
  $clockTime.textContent = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  $clockDate.textContent = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  updateNightMode();
  if (readings.length) renderMeta(); else fitText();
}
tick();
setInterval(tick, 10_000);
window.addEventListener("resize", () => { fitText(); drawGraph(); });

const LAYOUTS = ["", "layout-compact", "layout-focus"];
let currentLayout = 0, touchStartX = 0, touchStartY = 0;
function setLayout(i) {
  currentLayout = ((i % LAYOUTS.length) + LAYOUTS.length) % LAYOUTS.length;
  document.body.classList.remove("layout-focus", "layout-compact");
  if (LAYOUTS[currentLayout]) document.body.classList.add(LAYOUTS[currentLayout]);
  requestAnimationFrame(() => { fitText(); if (currentLayout === 0 && readings.length) drawGraph(); });
}
document.addEventListener("touchstart", (e) => { touchStartX = e.touches[0].clientX; touchStartY = e.touches[0].clientY; }, { passive: true });
document.addEventListener("touchend", (e) => {
  const dx = e.changedTouches[0].clientX - touchStartX, dy = e.changedTouches[0].clientY - touchStartY;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) setLayout(currentLayout + (dx < 0 ? 1 : -1));
}, { passive: true });
document.addEventListener("keydown", (e) => {
  if (!$setup.classList.contains("hidden")) return;
  if (e.key === "ArrowLeft") setLayout(currentLayout - 1);
  else if (e.key === "ArrowRight") setLayout(currentLayout + 1);
});

if (getCreds()) {
  $setup.classList.add("hidden");
  startApp();
}
