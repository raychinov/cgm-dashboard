import { expect, type Page } from "@playwright/test";
import { BASE_TIME, LANDSCAPE_VIEWPORTS, RISING, WIDE, connect, readings, stubDexcom, test } from "./dexcom";

const LAYOUTS = ["full", "compact", "focus"] as const;

function layoutProblems() {
  const W = innerWidth, H = innerHeight;
  const ids = ["clock-time", "clock-date", "glucose-row", "glucose", "trend", "meta", "banner", "graph-container", "x-labels"];
  const rects: Record<string, { l: number; t: number; r: number; b: number }> = {};
  const problems: string[] = [];
  for (const id of ids) {
    const el = document.getElementById(id)!;
    const b = el.getBoundingClientRect();
    if (b.width === 0 && b.height === 0) continue;
    rects[id] = { l: b.left, t: b.top, r: b.right, b: b.bottom };
    if (b.left < -1 || b.top < -1 || b.right > W + 1 || b.bottom > H + 1) problems.push(`${id} outside viewport`);
    if (el.scrollWidth > el.clientWidth + 1) problems.push(`${id} text clipped`);
  }
  const layout = document.body.classList.contains("layout-focus") ? "focus" : document.body.classList.contains("layout-compact") ? "compact" : "full";
  for (const id of ["glucose-row", "glucose", "trend", "meta"]) if (!rects[id]) problems.push(`${id} missing`);
  if (layout !== "focus" && !rects["clock-time"]) problems.push("clock missing");
  const overlaps = (a?: typeof rects[string], b?: typeof rects[string]) => a && b && !(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t);
  const pairs = [["clock-time", "glucose-row"], ["clock-date", "glucose-row"], ["clock-time", "clock-date"], ["glucose-row", "meta"], ["meta", "graph-container"], ["glucose-row", "graph-container"], ["clock-date", "graph-container"], ["banner", "glucose-row"], ["banner", "clock-time"]];
  for (const [a, b] of pairs) if (overlaps(rects[a], rects[b])) problems.push(`${a} overlaps ${b}`);
  const area = document.getElementById("reading-area")!.getBoundingClientRect();
  if (rects["glucose-row"] && (rects["glucose-row"].r > area.right + 1 || rects["glucose-row"].l < area.left - 1)) problems.push("glucose wider than reading-area");
  const graph = rects["graph-container"];
  if (graph && layout === "full" && graph.b - graph.t < 60) problems.push("graph too short");
  return problems;
}

async function settled(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

for (const vp of LANDSCAPE_VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    for (const [name, series] of [["rising", RISING], ["wide and stale", WIDE]] as const) {
      test(`nothing overflows or overlaps in any layout (${name})`, async ({ page }) => {
        await page.clock.setFixedTime(BASE_TIME);
        await stubDexcom(page, { read: () => ({ status: 200, body: readings(series) }) });
        await page.goto("/");
        await connect(page);
        await expect(page.locator("#glucose")).not.toHaveText("---");

        for (const layout of LAYOUTS) {
          await settled(page);
          expect(await page.evaluate(layoutProblems), `${vp.name} ${layout}`).toEqual([]);
          await page.keyboard.press("ArrowRight");
        }
      });
    }

    test("matches the visual snapshot of each layout", async ({ page }) => {
      await page.clock.setFixedTime(BASE_TIME);
      await stubDexcom(page);
      await page.goto("/");
      await connect(page);
      await expect(page.locator("#glucose")).toHaveText("16.9");

      for (const layout of LAYOUTS) {
        await settled(page);
        await expect(page).toHaveScreenshot(`${vp.name}-${layout}.png`, { animations: "disabled" });
        await page.keyboard.press("ArrowRight");
      }
    });
  });
}
