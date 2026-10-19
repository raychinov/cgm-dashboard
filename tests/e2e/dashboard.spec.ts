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

test("arrow keys and swipes cycle the three layouts", async ({ page }) => {
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
  await expect(body).not.toHaveClass(/layout-/);
  await expect(page.locator("#graph-area")).toBeVisible();

  await page.evaluate(() => {
    const touch = (type: string, x: number) =>
      document.dispatchEvent(new TouchEvent(type, { [type === "touchstart" ? "touches" : "changedTouches"]: [new Touch({ identifier: 1, target: document.body, clientX: x, clientY: 300 })] }));
    touch("touchstart", 300);
    touch("touchend", 100);
  });
  await expect(body).toHaveClass(/layout-compact/);
});

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
  await unlock(page);
  await expect(page.locator("#banner")).toBeHidden();
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
