import { describe, expect, it } from "vitest";
import {
  bandFor,
  colorHex,
  formatDelta,
  formatGlucose,
  fromDisplayUnit,
  graphRange,
  nextFetchDelay,
  nextLagEstimate,
  normalizeReadings,
  parseDexcomDate,
  parseSettings,
  summarize,
  toDisplayUnit,
  trendArrow,
  validThresholds,
} from "../display.js";

const thresholds = { urgentLow: 70, low: 81, high: 162, urgentHigh: 180 };
const MIN = 60_000;

describe("formatting", () => {
  it("formats glucose in mmol/L or mg/dL", () => {
    expect(formatGlucose(99, "mmol")).toBe("5.5");
    expect(formatGlucose(99, "mgdl")).toBe("99");
  });

  it("formats deltas with an explicit sign", () => {
    expect(formatDelta(9, "mmol")).toBe("+0.5");
    expect(formatDelta(-18, "mmol")).toBe("-1.0");
    expect(formatDelta(0, "mgdl")).toBe("+0");
    expect(formatDelta(-4, "mgdl")).toBe("-4");
  });

  it("maps trend codes and names to arrows, unknown to a dash", () => {
    expect(trendArrow(4)).toBe("→");
    expect(trendArrow("DoubleDown")).toBe("⇊");
    expect(trendArrow("NotComputable")).toBe("-");
    expect(trendArrow(undefined)).toBe("-");
  });

  it("parses Dexcom's /Date(ms)/ timestamps", () => {
    expect(parseDexcomDate("/Date(1700000000000)/")).toBe(1700000000000);
    expect(parseDexcomDate("garbage")).toBe(0);
    expect(parseDexcomDate(undefined)).toBe(0);
  });
});

describe("bands", () => {
  it("classifies against thresholds, boundaries inclusive", () => {
    expect(bandFor(70, thresholds)).toBe("urgent-low");
    expect(bandFor(71, thresholds)).toBe("low");
    expect(bandFor(81, thresholds)).toBe("low");
    expect(bandFor(82, thresholds)).toBe("in-range");
    expect(bandFor(161, thresholds)).toBe("in-range");
    expect(bandFor(162, thresholds)).toBe("high");
    expect(bandFor(180, thresholds)).toBe("urgent-high");
    expect(bandFor(300, thresholds)).toBe("urgent-high");
  });

  it("gives urgent bands red and warning bands yellow", () => {
    expect(colorHex(60, thresholds)).toBe("#8B0000");
    expect(colorHex(75, thresholds)).toBe("#8B8000");
    expect(colorHex(100, thresholds)).toBe("#008000");
    expect(colorHex(170, thresholds)).toBe("#8B8000");
    expect(colorHex(250, thresholds)).toBe("#8B0000");
  });
});

describe("normalizeReadings", () => {
  it("maps either casing, drops invalid rows, sorts ascending", () => {
    const raw = [
      { WT: "/Date(3000)/", Value: 120, Trend: 4 },
      { wt: "/Date(1000)/", value: 100, trend: "Flat" },
      { WT: "/Date(2000)/", Value: 0, Trend: 4 },
      { WT: "nope", Value: 110, Trend: 4 },
    ];

    expect(normalizeReadings(raw)).toEqual([
      { ts: 1000, mgdl: 100, trend: "Flat" },
      { ts: 3000, mgdl: 120, trend: 4 },
    ]);
  });

  it("tolerates null input", () => {
    expect(normalizeReadings(null)).toEqual([]);
  });

  it("skips null rows, coerces string values, and keeps one reading per timestamp", () => {
    const raw = [null, { WT: "/Date(1000)/", Value: "100", Trend: 4 }, { WT: "/Date(1000)/", Value: 130, Trend: 4 }, { WT: "/Date(2000)/", Value: "abc", Trend: 4 }];

    expect(normalizeReadings(raw)).toEqual([{ ts: 1000, mgdl: 130, trend: 4 }]);
  });
});

describe("summarize", () => {
  const now = 100 * MIN;

  it("returns null with no readings", () => {
    expect(summarize([], now, 15)).toBeNull();
  });

  it("reports age, delta and freshness", () => {
    const readings = [
      { ts: now - 9 * MIN, mgdl: 100, trend: 4 },
      { ts: now - 4 * MIN, mgdl: 112, trend: 4 },
    ];

    expect(summarize(readings, now, 15)).toEqual({ latest: readings[1], ageMin: 4, delta: 12, stale: false });
  });

  it("marks stale at the threshold and not a second before", () => {
    expect(summarize([{ ts: now - 15 * MIN, mgdl: 100, trend: 4 }], now, 15)).toMatchObject({ ageMin: 15, stale: true, delta: null });
    expect(summarize([{ ts: now - 15 * MIN + 1000, mgdl: 100, trend: 4 }], now, 15)).toMatchObject({ ageMin: 14, stale: false });
  });

  it("never reports a negative age for a reading from the future", () => {
    expect(summarize([{ ts: now + 2 * MIN, mgdl: 100, trend: 4 }], now, 15)).toMatchObject({ ageMin: 0, stale: false });
  });

  it("uses the time since the reading was first seen when the clock says it is younger", () => {
    const readings = [{ ts: now - 2 * MIN, mgdl: 100, trend: 4 }];
    expect(summarize(readings, now, 15, now - 20 * MIN)).toMatchObject({ ageMin: 20, stale: true });
    expect(summarize(readings, now, 15, now - 1 * MIN)).toMatchObject({ ageMin: 2, stale: false });
    expect(summarize(readings, now, 15, NaN)).toMatchObject({ ageMin: 2, stale: false });
  });

  it("omits the delta when the previous reading is too old to compare", () => {
    const readings = [
      { ts: now - 40 * MIN, mgdl: 100, trend: 4 },
      { ts: now - 2 * MIN, mgdl: 140, trend: 4 },
    ];

    expect(summarize(readings, now, 15)).toMatchObject({ delta: null });
  });
});

describe("nextFetchDelay", () => {
  const timing = { readingIntervalMs: 5 * MIN, readingLagMs: 20_000, retryMs: 20_000, overdueWindowMs: 3 * MIN, fallbackMs: 60_000 };
  const at = (ts: number) => [{ ts, mgdl: 100, trend: 4 }];
  const now = 1_000 * MIN;

  it("falls back to the plain interval with no readings", () => {
    expect(nextFetchDelay([], now, timing)).toBe(60_000);
  });

  it("waits until the next reading is due plus upload lag", () => {
    expect(nextFetchDelay(at(now - 2 * MIN), now, timing)).toBe(3 * MIN + 20_000);
  });

  it("never schedules closer than the minimum delay", () => {
    expect(nextFetchDelay(at(now - 5 * MIN - 19_000), now, timing)).toBe(5_000);
  });

  it("retries quickly while a reading is only slightly overdue", () => {
    expect(nextFetchDelay(at(now - 6 * MIN), now, timing)).toBe(20_000);
    expect(nextFetchDelay(at(now - 8 * MIN), now, timing)).toBe(20_000);
  });

  it("treats a reading timestamped in the future as clock skew and polls normally", () => {
    expect(nextFetchDelay(at(now + 2 * MIN), now, timing)).toBe(60_000);
  });

  it("never waits longer than one reading interval, whatever the clocks say", () => {
    expect(nextFetchDelay(at(now - 1), now, timing)).toBe(5 * MIN);
  });

  it("falls back to the plain interval once the reading is long overdue", () => {
    expect(nextFetchDelay(at(now - 9 * MIN), now, timing)).toBe(60_000);
    expect(nextFetchDelay(at(now - 120 * MIN), now, { ...timing, fallbackMs: 120_000 })).toBe(120_000);
  });
});

describe("nextLagEstimate", () => {
  it("adopts the first observation, clamped to ten minutes either way", () => {
    expect(nextLagEstimate(null, 12_000)).toBe(12_000);
    expect(nextLagEstimate(undefined, -900_000)).toBe(-600_000);
    expect(nextLagEstimate(NaN, 900_000)).toBe(600_000);
  });

  it("drops immediately when a reading shows up earlier than expected", () => {
    expect(nextLagEstimate(60_000, 8_000)).toBe(8_000);
    expect(nextLagEstimate(10_000, -120_000)).toBe(-120_000);
  });

  it("rises slowly when readings keep arriving later, so one slow fetch cannot push it out", () => {
    expect(nextLagEstimate(10_000, 65_000)).toBe(15_000);
    expect(nextLagEstimate(10_000, 12_000)).toBe(12_000);
  });
});

describe("graphRange", () => {
  it("keeps headroom above urgent-high so high readings are not clipped", () => {
    expect(graphRange([{ ts: 1, mgdl: 120, trend: 4 }], thresholds)).toEqual({ yMin: 36, yMax: 200 });
    expect(graphRange([{ ts: 1, mgdl: 300, trend: 4 }], thresholds)).toEqual({ yMin: 36, yMax: 320 });
    expect(graphRange([], thresholds)).toEqual({ yMin: 36, yMax: 200 });
  });
});

describe("settings", () => {
  const defaults = { units: "mmol", thresholds };

  it("validates thresholds as finite, in range and strictly increasing", () => {
    expect(validThresholds(thresholds)).toBe(true);
    expect(validThresholds({ ...thresholds, low: 70 })).toBe(false);
    expect(validThresholds({ ...thresholds, high: 60 })).toBe(false);
    expect(validThresholds({ ...thresholds, urgentLow: 39 })).toBe(false);
    expect(validThresholds({ ...thresholds, urgentLow: 40 })).toBe(true);
    expect(validThresholds({ ...thresholds, urgentHigh: 401 })).toBe(false);
    expect(validThresholds({ ...thresholds, urgentHigh: 400 })).toBe(true);
    expect(validThresholds({ ...thresholds, high: NaN })).toBe(false);
    expect(validThresholds({ ...thresholds, high: "162" })).toBe(false);
    expect(validThresholds({ urgentLow: 70, low: 81, high: 162 })).toBe(false);
    expect(validThresholds(null)).toBe(false);
  });

  it("falls back to the defaults for missing or broken storage", () => {
    expect(parseSettings(null, defaults)).toEqual(defaults);
    expect(parseSettings("not json", defaults)).toEqual(defaults);
    expect(parseSettings("[]", defaults)).toEqual(defaults);
    expect(parseSettings(JSON.stringify({ units: "lbs", thresholds: { low: 1 } }), defaults)).toEqual(defaults);
  });

  it("keeps a valid stored value per field and drops extras", () => {
    const stored = { units: "mgdl", thresholds: { ...thresholds, urgentHigh: 250, extra: 1 } };
    expect(parseSettings(JSON.stringify(stored), defaults)).toEqual({ units: "mgdl", thresholds: { ...thresholds, urgentHigh: 250 } });
    expect(parseSettings(JSON.stringify({ units: "mgdl" }), defaults)).toEqual({ units: "mgdl", thresholds });
    expect(parseSettings(JSON.stringify({ thresholds: { ...thresholds, low: 70 } }), defaults)).toEqual(defaults);
    expect(parseSettings(JSON.stringify(defaults), defaults).thresholds).not.toBe(defaults.thresholds);
  });

  it("converts thresholds to and from the display unit", () => {
    expect(toDisplayUnit(81, "mmol")).toBe(4.5);
    expect(toDisplayUnit(70, "mmol")).toBe(3.9);
    expect(toDisplayUnit(162, "mgdl")).toBe(162);
    expect(fromDisplayUnit("4.5", "mmol")).toBe(81);
    expect(fromDisplayUnit("10", "mmol")).toBe(180);
    expect(fromDisplayUnit("162.4", "mgdl")).toBe(162);
    expect(fromDisplayUnit("4,5", "mmol")).toBe(81);
    expect(fromDisplayUnit(" 7 ", "mmol")).toBe(126);
    expect(fromDisplayUnit("", "mmol")).toBeNaN();
    expect(fromDisplayUnit("abc", "mgdl")).toBeNaN();
  });

  it("round-trips every one-decimal mmol/L value through integer mg/dL", () => {
    for (let tenths = 20; tenths <= 300; tenths++) {
      const mmol = tenths / 10;
      expect(toDisplayUnit(fromDisplayUnit(String(mmol), "mmol"), "mmol")).toBe(mmol);
    }
  });
});
