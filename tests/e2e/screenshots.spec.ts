import { expect } from "@playwright/test";
import { BASE_TIME, CALM, connect, readings, stubDexcom, test } from "./dexcom";

test.use({ viewport: { width: 956, height: 440 } });

test("capture the README screenshots", async ({ page }) => {
  await page.clock.setFixedTime(BASE_TIME);
  await stubDexcom(page, { read: () => ({ status: 200, body: readings(CALM) }) });
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("6.6");

  for (const layout of ["full", "compact", "focus", "settings"]) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: `docs/screenshots/${layout}.png`, animations: "disabled" });
    await page.keyboard.press("ArrowRight");
  }
});
