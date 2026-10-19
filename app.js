import { DexcomError, getReadings, getCreds, setCreds, clearCreds, invalidateSession } from "./dexcom-client.js";
import { bandFor, colorHex, formatDelta, formatGlucose, graphRange, nextFetchDelay, normalizeReadings, summarize, trendArrow } from "./display.js";

const CONFIG = {
  units: "mmol",
  thresholds: { urgentLow: 70, low: 81, high: 162, urgentHigh: 180 },
  readingIntervalMs: 300_000,
  readingLagMs: 0,
  retryMs: 5_000,
  overdueWindowMs: 180_000,
  refreshMs: 60_000,
  nightRefreshMs: 120_000,
  nightStartHour: 22,
  nightEndHour: 7,
  staleMinutes: 15,
  graphHours: 3,
  minutes: 180,
  maxCount: 36,
};

const $ = (id) => document.getElementById(id);
const $glucose = $("glucose"), $trend = $("trend"), $meta = $("meta"), $banner = $("banner");
const $canvas = $("graph"), $overlay = $("overlay"), $setup = $("setup"), $nosleep = $("nosleep");
const $form = $("setup-form"), $u = $("setup-username"), $p = $("setup-password");
const $server = $("setup-server"), $save = $("setup-save"), $err = $("setup-error");
const $clockTime = $("clock-time"), $clockDate = $("clock-date");
const $clock = $("clock"), $readingArea = $("reading-area"), $glucoseRow = $("glucose-row");

let readings = [];
let refreshTimer = null;
let running = false;
let run = 0;

function showSetupError(msg) { $err.textContent = msg; $err.style.display = "block"; }
function hideSetupError() { $err.style.display = "none"; }

function showSetup(message, username = "") {
  stopApp();
  clearCreds();
  readings = [];
  clearError();
  updateDisplay();
  $u.value = username;
  $p.value = "";
  $setup.classList.remove("hidden");
  if (message) showSetupError(message); else hideSetupError();
  (username ? $p : $u).focus();
}

function describeFailure(err) {
  if (err instanceof DexcomError) {
    if (err.isLocked) return "Dexcom locked the account after too many failed logins. Wait 15 minutes, then try again.";
    if (err.isAuthError) return "Dexcom rejected the login. Check the username, password and region.";
    return `Dexcom error: ${err.code}`;
  }
  return "Could not reach Dexcom. Check the network connection.";
}

function needsTapToStart() {
  return navigator.maxTouchPoints > 0 || /Mobi|Android/i.test(navigator.userAgent);
}

function dismissSetupAndStart() {
  $setup.classList.add("hidden");
  $overlay.classList.toggle("hidden", !needsTapToStart());
  startApp();
}

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
    invalidateSession();
    const data = await getReadings({ ...creds, minutes: CONFIG.minutes, maxCount: CONFIG.maxCount });
    if (!data || data.length === 0) {
      showSetupError("Connected, but Dexcom returned no readings. Use the account signed in on the phone with the sensor, not a follower's. In the Dexcom app, Connections, Share must be on with at least one follower.");
      return;
    }
    setCreds(creds);
    readings = normalizeReadings(data);
    clearError();
    updateDisplay();
    dismissSetupAndStart();
  } catch (err) {
    clearCreds();
    showSetupError(describeFailure(err));
  } finally {
    $save.disabled = false;
    $save.textContent = "Connect";
  }
}
$form.addEventListener("submit", submitCreds);

let resetTaps = 0, resetTimer = null;
$("reset-zone").addEventListener("click", () => {
  resetTaps++;
  clearTimeout(resetTimer);
  if (resetTaps >= 2) { resetTaps = 0; showSetup("", (getCreds() || {}).username); }
  else resetTimer = setTimeout(() => { resetTaps = 0; }, 400);
});

async function fetchReadings() {
  const creds = getCreds();
  if (!creds) return false;
  const thisRun = run;
  try {
    const data = await getReadings({ ...creds, minutes: CONFIG.minutes, maxCount: CONFIG.maxCount });
    if (thisRun !== run) return false;
    readings = normalizeReadings(data);
    clearError();
    updateDisplay();
    return true;
  } catch (err) {
    if (thisRun !== run) return false;
    console.error("Fetch error:", err);
    if (err instanceof DexcomError && err.isAuthError) {
      showSetup(describeFailure(err), creds.username);
      return false;
    }
    showError("NO DATA");
    renderMeta();
    return false;
  }
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
  if ($banner.className === "error") return;
  if (summary && summary.stale) {
    $banner.textContent = "STALE (" + summary.ageMin + " min)";
    $banner.className = "stale";
  } else if ($banner.className === "stale") {
    $banner.className = "";
    $banner.textContent = "";
  }
}

function renderMeta() {
  const summary = summarize(readings, Date.now(), CONFIG.staleMinutes);
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

function showError(msg) { $banner.textContent = msg; $banner.className = "error"; }
function clearError() { if ($banner.className === "error") { $banner.className = ""; $banner.textContent = ""; } }

const SILENT_MP4 = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAAhtZGF0AAAAMW1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAHV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAgAAAAIAAAAAAAJGVkdHMAAAAcZWxzdAAAAAAAAAABAAAAAAAAAAEAAAAAAA==";

function keepAwake() {
  if (navigator.wakeLock) navigator.wakeLock.request("screen").catch(() => {});
  $nosleep.src = SILENT_MP4;
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
  const delay = afterFailure ? fallbackMs : nextFetchDelay(readings, Date.now(), { ...CONFIG, fallbackMs });
  refreshTimer = setTimeout(refresh, delay);
}
function startApp() {
  run++;
  running = true;
  keepAwake();
  if (readings.length) scheduleNextFetch(); else refresh();
}
function stopApp() { run++; running = false; clearTimeout(refreshTimer); }

$overlay.addEventListener("click", () => {
  $overlay.classList.add("hidden");
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  keepAwake();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !running) return;
  keepAwake();
  refresh();
});

function tick() {
  const now = new Date();
  $clockTime.textContent = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  $clockDate.textContent = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  updateNightMode();
  if (readings.length) renderMeta(); else fitText();
}
const $xLabels = $("x-labels");
$xLabels.textContent = "";
for (let h = CONFIG.graphHours; h >= 0; h--) {
  const label = document.createElement("span");
  label.textContent = h ? `-${h}h` : "now";
  $xLabels.appendChild(label);
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

if (getCreds()) dismissSetupAndStart();
