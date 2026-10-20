import { expect, type Page } from "@playwright/test";
import { APP_ID_US, BASE_TIME, RISING, connect, dexcomFailure, freezeClock, readings, stubDexcom, test } from "./dexcom";

const WAKE_LOCK_MOCK = `
  window.__wake = { requests: 0, release: null };
  Object.defineProperty(navigator, "wakeLock", { value: { request: async () => {
    window.__wake.requests++;
    const listeners = [];
    window.__wake.release = () => listeners.forEach((fn) => fn());
    return { released: false, addEventListener: (type, fn) => listeners.push(fn), release: async () => {} };
  } } });
`;

async function unlock(page: Page) {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

test.beforeEach(async ({ page }) => {
  await freezeClock(page);
});

test("setup flow: credentials go to the chosen Dexcom host and the dashboard shows the latest reading", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await expect(page.locator("#setup")).toBeVisible();

  await connect(page, { server: "us" });

  await expect(page.locator("#setup")).toBeHidden();
  await expect(page.locator("#glucose")).toHaveText("16.9");
  await expect(page.locator("#glucose")).toHaveClass("color-urgent-high");
  await expect(page.locator("#trend")).toHaveText("↑");
  await expect(page.locator("#meta")).toHaveText("+2.5 · 2 min ago");
  await expect(page.locator("#fullscreen-hint")).toBeHidden();
  expect(stub.calls).toEqual({ auth: 1, login: 1, read: 1 });
  expect(stub.requests.map((r) => r.host)).toEqual(["share2.dexcom.com", "share2.dexcom.com", "share2.dexcom.com"]);
  expect(stub.requests[0].body).toEqual({ accountName: "sharer@example.com", password: "pw", applicationId: APP_ID_US });
  expect(stub.requests[1].body).toEqual({ accountId: "11111111-1111-1111-1111-111111111111", password: "pw", applicationId: APP_ID_US });
  expect(stub.requests[2].query).toEqual({ sessionId: "22222222-2222-2222-2222-222222222222", minutes: "180", maxCount: "36" });
  expect(await page.evaluate(() => document.body.className)).toBe("");
  const creds = await page.evaluate(() => JSON.parse(localStorage.getItem("cgm.creds")!));
  expect(creds).toEqual({ username: "sharer@example.com", password: "pw", server: "us" });
});

test("wrong password shows the login error and stores nothing", async ({ page }) => {
  const stub = await stubDexcom(page, { auth: dexcomFailure("AccountPasswordInvalid") });
  await page.goto("/");

  await connect(page);

  await expect(page.locator("#setup-error")).toContainText("Dexcom rejected the login");
  await expect(page.locator("#setup")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("cgm.creds"))).toBeNull();
  expect(stub.calls).toEqual({ auth: 1, login: 0, read: 0 });
});

test("lockout shows the wait message and makes exactly one login attempt", async ({ page }) => {
  const stub = await stubDexcom(page, { auth: dexcomFailure("SSO_AuthenticateMaxAttemptsExceeded") });
  await page.goto("/");

  await connect(page);

  await expect(page.locator("#setup-error")).toContainText("locked the account");
  await page.clock.runFor(10 * 60_000);
  expect(stub.calls).toEqual({ auth: 1, login: 0, read: 0 });
  expect(await page.evaluate(() => localStorage.getItem("cgm.creds"))).toBeNull();
});

test("a follower login gets the sharer-account hint", async ({ page }) => {
  await stubDexcom(page, { read: () => ({ status: 200, body: [] }) });
  await page.goto("/");

  await connect(page);

  await expect(page.locator("#setup-error")).toContainText("not a follower's");
  await expect(page.locator("#setup")).toBeVisible();
});

test("arrow keys and swipes cycle the four views", async ({ page }) => {
  await stubDexcom(page);
  await page.goto("/");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("body")).not.toHaveClass(/layout-/);
  await connect(page);
  await expect(page.locator("#setup")).toBeHidden();
  const body = page.locator("body");

  await page.keyboard.press("ArrowRight");
  await expect(body).toHaveClass(/layout-compact/);
  await expect(page.locator("#graph-area")).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await expect(body).toHaveClass(/layout-focus/);
  await expect(page.locator("#clock")).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await expect(body).toHaveClass(/layout-settings/);
  await expect(page.locator("#settings")).toBeVisible();
  await expect(page.locator("#top-bar")).toBeHidden();
  await expect(page.locator("#graph-area")).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await expect(body).not.toHaveClass(/layout-/);
  await expect(page.locator("#settings")).toBeHidden();
  await expect(page.locator("#graph-area")).toBeVisible();

  await swipe(page, 300, 100);
  await expect(body).toHaveClass(/layout-compact/);
});

async function swipe(page: Page, fromX: number, toX: number) {
  await page.evaluate(([fromX, toX]) => {
    const touch = (type: string, x: number) =>
      document.dispatchEvent(new TouchEvent(type, { [type === "touchstart" ? "touches" : "changedTouches"]: [new Touch({ identifier: 1, target: document.body, clientX: x, clientY: 300 })] }));
    touch("touchstart", fromX);
    touch("touchend", toX);
  }, [fromX, toX]);
}

test("stale readings raise the STALE banner", async ({ page }) => {
  await stubDexcom(page, { read: () => ({ status: 200, body: readings([[20, 110, 4], [25, 112, 4]]) }) });
  await page.goto("/");

  await connect(page);

  await expect(page.locator("#banner")).toHaveClass("stale");
  await expect(page.locator("#banner")).toHaveText("STALE (20 min)");
});

test("an empty answer keeps the last reading, which goes grey and STALE as it ages", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");

  stub.read = () => ({ status: 200, body: [] });
  await unlock(page);
  await expect.poll(() => stub.calls.read).toBe(2);

  await expect(page.locator("#glucose")).toHaveText("16.9");
  await expect(page.locator("#banner")).toBeHidden();
  await expect(page.locator("#glucose")).toHaveCSS("color", "rgb(139, 0, 0)");

  await page.clock.fastForward(14 * 60_000);
  await expect(page.locator("#banner")).toHaveText("STALE (16 min)");
  await expect(page.locator("body")).toHaveClass(/stale/);
  await expect(page.locator("#glucose")).toHaveCSS("color", "rgb(119, 119, 119)");
  await expect(page.locator("#trend")).toHaveCSS("color", "rgb(119, 119, 119)");
  await expect(page.locator("#meta")).toHaveText("+2.5 · 16 min ago");

  await page.clock.fastForward(4 * 60 * 60_000);
  await expect(page.locator("#glucose")).toHaveText("16.9");
  await expect(page.locator("#banner")).toHaveText("STALE (256 min)");
});

test("NO DATA names the age of the last reading once it is stale", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");

  stub.read = dexcomFailure("InvalidArgument");
  await unlock(page);
  await expect(page.locator("#banner")).toHaveText("NO DATA");

  await page.clock.fastForward(14 * 60_000);
  await expect(page.locator("#banner")).toHaveText("NO DATA · last reading 16 min ago");
  await expect(page.locator("#glucose")).toHaveCSS("color", "rgb(119, 119, 119)");

  stub.read = () => ({ status: 200, body: readings(RISING, BASE_TIME + 16 * 60_000) });
  await expect(async () => {
    await unlock(page);
    await expect(page.locator("#banner")).toBeHidden({ timeout: 500 });
  }).toPass();
  await expect(page.locator("#glucose")).toHaveCSS("color", "rgb(139, 0, 0)");
});

test("a phone clock that runs behind cannot hide staleness", async ({ page }) => {
  await stubDexcom(page, { read: () => ({ status: 200, body: readings(RISING, BASE_TIME + 60 * 60_000) }) });
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#meta")).toHaveText("+2.5 · 0 min ago");

  await page.clock.fastForward(16 * 60_000);

  await expect(page.locator("#banner")).toHaveText("STALE (16 min)");
  await expect(page.locator("body")).toHaveClass(/stale/);
});

test("a failed refresh shows NO DATA, keeps the last reading, and waits the slow interval", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");

  stub.read = dexcomFailure("InvalidArgument");
  await unlock(page);

  await expect(page.locator("#banner")).toHaveClass("error");
  await expect(page.locator("#banner")).toHaveText("NO DATA");
  await expect(page.locator("#glucose")).toHaveText("16.9");
  await expect.poll(() => stub.calls.read).toBe(2);
  await page.waitForTimeout(150);
  await page.clock.runFor(55_000);
  await page.waitForTimeout(150);
  expect(stub.calls.read).toBe(2);
  await page.clock.runFor(6_000);
  await expect.poll(() => stub.calls.read).toBe(3);
});

test("a password change mid-run shows LOGGED OUT, keeps the credentials, stops polling, and a tap retries once", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");

  stub.read = dexcomFailure("SessionNotValid");
  stub.login = dexcomFailure("AccountPasswordInvalid");
  await unlock(page);

  await expect(page.locator("#banner")).toContainText("LOGGED OUT");
  await expect(page.locator("#banner")).toContainText("Dexcom rejected the login");
  await expect(page.locator("#setup")).toBeHidden();
  await expect(page.locator("#glucose")).toHaveText("16.9");
  expect(await page.evaluate(() => localStorage.getItem("cgm.creds"))).not.toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("cgm.account"))).toBeNull();
  expect(stub.calls).toEqual({ auth: 1, login: 2, read: 2 });

  await page.clock.runFor(10 * 60_000);
  await page.waitForTimeout(150);
  expect(stub.calls).toEqual({ auth: 1, login: 2, read: 2 });

  await page.mouse.click(400, 200);
  await expect.poll(() => stub.calls.login).toBe(3);
  expect(stub.calls.auth).toBe(2);
  await expect(page.locator("#banner")).toContainText("LOGGED OUT");

  stub.login = () => ({ status: 200, body: "22222222-2222-2222-2222-222222222222" });
  stub.read = () => ({ status: 200, body: readings(RISING) });
  await page.mouse.click(400, 200);
  await expect(page.locator("#banner")).toBeHidden();
  await expect.poll(() => stub.calls.read).toBe(3);
});

test("a lockout mid-run shows LOGGED OUT and stops polling", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");

  stub.read = dexcomFailure("SessionNotValid");
  stub.login = dexcomFailure("SSO_AuthenticateMaxAttemptsExceeded");
  await unlock(page);

  await expect(page.locator("#banner")).toContainText("account locked");
  await page.clock.runFor(10 * 60_000);
  await page.waitForTimeout(150);
  expect(stub.calls).toEqual({ auth: 1, login: 2, read: 2 });
});

test("an SSO_InternalError logout retries by itself after an hour", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");

  stub.read = dexcomFailure("SessionNotValid");
  stub.login = () => ({ status: 500, body: { Code: "SSO_InternalError", Message: "Cannot Authenticate by AccountId" } });
  await unlock(page);
  await expect(page.locator("#banner")).toContainText("LOGGED OUT");
  expect(stub.calls).toEqual({ auth: 1, login: 2, read: 2 });

  await page.clock.runFor(60 * 60_000 - 1_000);
  await page.waitForTimeout(300);
  expect(stub.calls.login).toBe(2);
  await page.clock.runFor(2_000);
  await expect.poll(() => stub.calls.login).toBe(3);
  expect(stub.calls.auth).toBe(2);
  await expect(page.locator("#banner")).toContainText("LOGGED OUT");
});

test("a server error during a session refresh keeps the account id and pauses logins for 5 minutes", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");

  stub.read = dexcomFailure("SessionNotValid");
  stub.login = () => ({ status: 503, body: "<html>unavailable</html>" });
  await unlock(page);

  await expect(page.locator("#banner")).toHaveText("NO DATA");
  await expect(page.locator("#setup")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("cgm.account"))).not.toBeNull();
  expect(stub.calls).toEqual({ auth: 1, login: 2, read: 2 });

  await page.waitForTimeout(150);
  await page.clock.runFor(4 * 60_000);
  await page.waitForTimeout(150);
  expect(stub.calls.login).toBe(2);
  await expect(page.locator("#banner")).toContainText("logins paused");
  await page.clock.runFor(2 * 60_000);
  await expect.poll(() => stub.calls.login).toBe(3);
});

test("the next fetch waits for the reading that is due, retries every 5 s, and learns the lag", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");
  const expectReads = async (n: number) => {
    await expect.poll(() => stub.calls.read).toBe(n);
    await page.waitForTimeout(150);
  };

  await page.clock.runFor(189_000);
  await page.waitForTimeout(100);
  expect(stub.calls.read).toBe(1);
  await page.clock.runFor(2_000);
  await expectReads(2);

  await page.clock.runFor(5_000);
  await expectReads(3);
  await page.clock.runFor(5_000);
  await expectReads(4);

  stub.read = () => ({ status: 200, body: readings(RISING, BASE_TIME + 300_000) });
  await page.clock.runFor(5_000);
  await expectReads(5);
  expect(await page.evaluate(() => localStorage.getItem("cgm.lag"))).toBe("15000");
  await page.clock.runFor(60_000);
  await page.waitForTimeout(200);
  expect(stub.calls.read).toBe(5);
});

test("overlapping refresh requests are coalesced", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");

  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect.poll(() => stub.calls.read).toBe(2);
  await page.clock.runFor(2_000);
  await page.waitForTimeout(100);
  expect(stub.calls.read).toBe(2);
});

test("night mode dims the page after 22:00", async ({ page }) => {
  await stubDexcom(page);
  await page.clock.setSystemTime(new Date("2026-10-19T23:00:00").getTime());
  await page.goto("/");

  await expect(page.locator("body")).toHaveClass(/night-mode/);
});

test("stored credentials fetch at once, show a fullscreen hint on touch devices, and keep the screen awake", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 956, height: 440 } });
  const page = await context.newPage();
  await freezeClock(page);
  await stubDexcom(page);
  await page.addInitScript(WAKE_LOCK_MOCK);
  await page.addInitScript(() => localStorage.setItem("cgm.creds", JSON.stringify({ username: "u", password: "p", server: "ous" })));
  await page.goto("/");

  await expect(page.locator("#setup")).toBeHidden();
  await expect(page.locator("#glucose")).toHaveText("16.9");
  await expect(page.locator("#fullscreen-hint")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__wake.requests)).toBe(1);
  await expect.poll(() => page.evaluate(() => (document.getElementById("nosleep") as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);

  await page.touchscreen.tap(400, 200);
  await expect(page.locator("#fullscreen-hint")).toBeHidden();

  await page.evaluate(() => (window as any).__wake.release());
  await page.clock.runFor(1_500);
  await expect.poll(() => page.evaluate(() => (window as any).__wake.requests)).toBe(2);
  await context.close();
});

test("the fullscreen hint goes away by itself after 30 s", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 956, height: 440 } });
  const page = await context.newPage();
  await freezeClock(page);
  await stubDexcom(page);
  await page.addInitScript(() => localStorage.setItem("cgm.creds", JSON.stringify({ username: "u", password: "p", server: "ous" })));
  await page.goto("/");
  await expect(page.locator("#fullscreen-hint")).toBeVisible();

  await page.clock.runFor(31_000);

  await expect(page.locator("#fullscreen-hint")).toBeHidden();
  await context.close();
});

async function openSettings(page: Page) {
  await expect(page.locator("#setup")).toBeHidden();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("body")).toHaveClass(/layout-settings/);
}

async function typeThreshold(page: Page, id: string, value: string) {
  const input = page.locator(`#${id}`);
  await input.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
  await expect(input).not.toBeFocused();
}

async function closeSettings(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("body")).not.toHaveClass(/layout-/);
}

test("settings show the account and the current values in the display unit", async ({ page }) => {
  await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");

  await openSettings(page);

  await expect(page.locator("#settings-account")).toHaveText("Signed in as sharer@example.com · OUS");
  await expect(page.locator("input[name=units][value=mmol]")).toBeChecked();
  await expect(page.locator("#settings-unit-label")).toHaveText("mmol/L");
  await expect(page.locator("#threshold-urgentLow")).toHaveValue("3.9");
  await expect(page.locator("#threshold-low")).toHaveValue("4.5");
  await expect(page.locator("#threshold-high")).toHaveValue("9");
  await expect(page.locator("#threshold-urgentHigh")).toHaveValue("10");
  expect(await page.evaluate(() => localStorage.getItem("cgm.settings"))).toBeNull();
});

test("switching units re-renders the reading and survives a reload", async ({ page }) => {
  await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");
  await openSettings(page);

  await page.click("#settings-units label:has(input[value=mgdl])");

  await expect(page.locator("#settings-unit-label")).toHaveText("mg/dL");
  await expect(page.locator("#threshold-urgentLow")).toHaveValue("70");
  await expect(page.locator("#threshold-urgentHigh")).toHaveValue("180");
  await closeSettings(page);
  await expect(page.locator("#glucose")).toHaveText("305");
  await expect(page.locator("#meta")).toHaveText("+45 · 2 min ago");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cgm.settings")!))).toEqual({
    units: "mgdl",
    thresholds: { urgentLow: 70, low: 81, high: 162, urgentHigh: 180 },
  });

  await page.reload();
  await expect(page.locator("#glucose")).toHaveText("305");
});

test("a threshold change recolours the reading at once; an out-of-order value is refused", async ({ page }) => {
  await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveClass("color-urgent-high");
  await openSettings(page);

  await typeThreshold(page, "threshold-urgentHigh", "20");

  await expect(page.locator("#threshold-urgentHigh")).toHaveValue("20");
  await expect(page.locator("#settings-error")).toBeHidden();
  await expect(page.locator("#glucose")).toHaveClass("color-high");
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem("cgm.settings")!))).thresholds.urgentHigh).toBe(360);

  await typeThreshold(page, "threshold-low", "19.5");

  await expect(page.locator("#settings-error")).toBeVisible();
  await expect(page.locator("#settings-error")).toContainText("must increase");
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem("cgm.settings")!))).thresholds.low).toBe(81);

  await typeThreshold(page, "threshold-low", "4,6");
  await expect(page.locator("#settings-error")).toBeHidden();
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem("cgm.settings")!))).thresholds.low).toBe(83);
  await expect(page.locator("#threshold-low")).toHaveValue("4.6");

  await page.reload();
  await expect(page.locator("#glucose")).toHaveText("16.9");
  await expect(page.locator("#glucose")).toHaveClass("color-high");
});

test("editing one threshold in mmol/L leaves the other three exactly as stored", async ({ page }) => {
  await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await openSettings(page);
  await page.click("#settings-units label:has(input[value=mgdl])");
  await typeThreshold(page, "threshold-high", "170");
  await page.click("#settings-units label:has(input[value=mmol])");
  await expect(page.locator("#threshold-high")).toHaveValue("9.4");

  await typeThreshold(page, "threshold-urgentHigh", "11");

  expect((await page.evaluate(() => JSON.parse(localStorage.getItem("cgm.settings")!))).thresholds).toEqual({ urgentLow: 70, low: 81, high: 170, urgentHigh: 198 });
});

test("arrow keys inside a settings field edit the field instead of switching views", async ({ page }) => {
  await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await openSettings(page);

  await page.focus("#threshold-high");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");

  await expect(page.locator("body")).toHaveClass(/layout-settings/);
});

test("log out needs two taps, forgets the credentials, stops polling and keeps the settings", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");
  await openSettings(page);
  await page.click("#settings-units label:has(input[value=mgdl])");
  const logout = page.locator("#settings-logout");

  await logout.click();
  await expect(logout).toHaveText("Tap again to log out");
  await expect(page.locator("#setup")).toBeHidden();
  await page.clock.runFor(6_000);
  await expect(logout).toHaveText("Log out");
  expect(await page.evaluate(() => localStorage.getItem("cgm.creds"))).not.toBeNull();

  await logout.click();
  await logout.click();
  await expect(logout).toHaveText("Tap again to log out");
  await expect(page.locator("#setup")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("cgm.creds"))).not.toBeNull();

  await page.clock.runFor(1_000);
  await logout.click();

  await expect(page.locator("#setup")).toBeVisible();
  await expect(page.locator("body")).not.toHaveClass(/layout-/);
  await expect(page.locator("#setup-username")).toHaveValue("");
  await expect(page.locator("#glucose")).toHaveText("---");
  expect(await page.evaluate(() => localStorage.getItem("cgm.creds"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("cgm.session"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("cgm.account"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("cgm.seen"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("cgm.lag"))).toBeNull();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cgm.settings")!).units)).toBe("mgdl");
  const reads = stub.calls.read;
  await page.clock.runFor(10 * 60_000);
  await page.waitForTimeout(150);
  expect(stub.calls.read).toBe(reads);

  await swipe(page, 300, 100);
  await connect(page, { username: "other@example.com", server: "us" });
  await expect(page.locator("#setup")).toBeHidden();
  await expect(page.locator("body")).not.toHaveClass(/layout-/);
  await expect(page.locator("#glucose")).toHaveText("305");
  expect(stub.requests.at(-3)!.body).toMatchObject({ accountName: "other@example.com" });
});

test("leaving the settings view disarms the log-out button", async ({ page }) => {
  await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await openSettings(page);
  await page.click("#settings-logout");
  await expect(page.locator("#settings-logout")).toHaveText("Tap again to log out");

  await closeSettings(page);
  await openSettings(page);

  await expect(page.locator("#settings-logout")).toHaveText("Log out");
});

test("log out from the LOGGED OUT state cancels the hourly retry", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");
  stub.read = dexcomFailure("SessionNotValid");
  stub.login = () => ({ status: 500, body: { Code: "SSO_InternalError", Message: "Cannot Authenticate by AccountId" } });
  await unlock(page);
  await expect(page.locator("#banner")).toContainText("LOGGED OUT");
  const logins = stub.calls.login;

  await openSettings(page);
  await page.click("#settings-logout");
  await page.clock.runFor(1_000);
  await page.click("#settings-logout");

  await expect(page.locator("#setup")).toBeVisible();
  await expect(page.locator("#banner")).toBeHidden();
  await page.clock.runFor(2 * 60 * 60_000);
  await page.waitForTimeout(150);
  expect(stub.calls.login).toBe(logins);
});

test("a swipe while LOGGED OUT changes the view without retrying the login", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");
  stub.read = dexcomFailure("SessionNotValid");
  stub.login = dexcomFailure("AccountPasswordInvalid");
  await unlock(page);
  await expect(page.locator("#banner")).toContainText("LOGGED OUT");
  expect(stub.calls.login).toBe(2);

  await swipe(page, 300, 100);
  await expect(page.locator("body")).toHaveClass(/layout-compact/);
  await swipe(page, 300, 100);
  await swipe(page, 300, 100);
  await expect(page.locator("body")).toHaveClass(/layout-settings/);
  await page.waitForTimeout(150);

  expect(stub.calls.login).toBe(2);
  await expect(page.locator("#banner")).toContainText("LOGGED OUT");

  await swipe(page, 100, 300);
  await swipe(page, 100, 300);
  await swipe(page, 100, 300);
  await expect(page.locator("body")).not.toHaveClass(/layout-/);
  await swipe(page, 300, 300);
  await expect.poll(() => stub.calls.login).toBe(3);
});

test("a tap on the settings screen while LOGGED OUT does not retry the login", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");
  stub.read = dexcomFailure("SessionNotValid");
  stub.login = dexcomFailure("AccountPasswordInvalid");
  await unlock(page);
  await expect(page.locator("#banner")).toContainText("LOGGED OUT");
  expect(stub.calls.login).toBe(2);

  await openSettings(page);
  await page.click("#settings-account");
  await page.waitForTimeout(150);

  expect(stub.calls.login).toBe(2);
  await expect(page.locator("#banner")).toContainText("LOGGED OUT");
});
