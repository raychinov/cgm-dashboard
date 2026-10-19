const TREND_ARROWS = {
  1: "⇈", 2: "↑", 3: "↗", 4: "→", 5: "↘", 6: "↓", 7: "⇊",
  DoubleUp: "⇈", SingleUp: "↑", FortyFiveUp: "↗", Flat: "→",
  FortyFiveDown: "↘", SingleDown: "↓", DoubleDown: "⇊",
};

const MAX_DELTA_GAP_MS = 7 * 60_000;
const GRAPH_Y_MIN = 36;
const GRAPH_Y_HEADROOM = 20;

export function mgdlToMmol(mgdl) {
  return mgdl / 18;
}

export function formatGlucose(mgdl, units) {
  return units === "mmol" ? mgdlToMmol(mgdl).toFixed(1) : String(Math.round(mgdl));
}

export function formatDelta(delta, units) {
  const value = units === "mmol" ? mgdlToMmol(delta).toFixed(1) : String(Math.round(delta));
  return (delta >= 0 ? "+" : "") + value;
}

export function bandFor(mgdl, t) {
  if (mgdl <= t.urgentLow) return "urgent-low";
  if (mgdl <= t.low) return "low";
  if (mgdl >= t.urgentHigh) return "urgent-high";
  if (mgdl >= t.high) return "high";
  return "in-range";
}

const BAND_HEX = {
  "urgent-low": "#8B0000",
  low: "#8B8000",
  "in-range": "#008000",
  high: "#8B8000",
  "urgent-high": "#8B0000",
};

export function colorHex(mgdl, thresholds) {
  return BAND_HEX[bandFor(mgdl, thresholds)];
}

export function trendArrow(trend) {
  return TREND_ARROWS[trend] ?? "-";
}

export function parseDexcomDate(wt) {
  const match = String(wt ?? "").match(/Date\((\d+)\)/);
  return match ? parseInt(match[1], 10) : 0;
}

export function normalizeReadings(raw) {
  const byTs = new Map();
  for (const r of raw ?? []) {
    if (!r || typeof r !== "object") continue;
    const ts = parseDexcomDate(r.WT ?? r.wt ?? r.ST ?? r.st);
    const mgdl = Number(r.Value ?? r.value);
    if (ts > 0 && mgdl > 0) byTs.set(ts, { ts, mgdl, trend: r.Trend ?? r.trend ?? 0 });
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

export function summarize(readings, now, staleMinutes, seenAt = NaN) {
  if (!readings.length) return null;
  const latest = readings[readings.length - 1];
  const prev = readings[readings.length - 2];
  const sinceSeen = Number.isFinite(seenAt) ? now - seenAt : 0;
  const ageMin = Math.max(0, Math.floor(Math.max(now - latest.ts, sinceSeen) / 60_000));
  const delta = prev && latest.ts - prev.ts <= MAX_DELTA_GAP_MS ? latest.mgdl - prev.mgdl : null;
  return { latest, ageMin, delta, stale: ageMin >= staleMinutes };
}

const LAG_MIN_MS = -600_000;
const LAG_MAX_MS = 600_000;
const LAG_RISE_MS = 5_000;

export function nextLagEstimate(current, observed) {
  const clamped = Math.min(LAG_MAX_MS, Math.max(LAG_MIN_MS, observed));
  if (typeof current !== "number" || Number.isNaN(current)) return clamped;
  return clamped < current ? clamped : Math.min(clamped, current + LAG_RISE_MS);
}

const MIN_FETCH_DELAY_MS = 5_000;

export function nextFetchDelay(readings, now, { readingIntervalMs, readingLagMs, retryMs, overdueWindowMs, fallbackMs }) {
  if (!readings.length) return fallbackMs;
  const latest = readings[readings.length - 1].ts;
  if (latest > now) return fallbackMs;
  const due = latest + readingIntervalMs + readingLagMs;
  if (now < due) return Math.min(Math.max(due - now, MIN_FETCH_DELAY_MS), readingIntervalMs);
  return now - due < overdueWindowMs ? retryMs : fallbackMs;
}

export function graphRange(readings, thresholds) {
  const peak = readings.reduce((max, r) => Math.max(max, r.mgdl), thresholds.urgentHigh);
  return { yMin: GRAPH_Y_MIN, yMax: peak + GRAPH_Y_HEADROOM };
}
