import { expect } from "@playwright/test";
import { APP_ID_US, BASE_TIME, RISING, connect, dexcomFailure, freezeClock, readings, stubDexcom, test } from "./dexcom";

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

test("a failed refresh shows NO DATA, keeps the last reading, and waits the slow interval", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");

  stub.read = dexcomFailure("InvalidArgument");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

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

test("a password change mid-run returns to setup and stops the loop", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");

  stub.read = dexcomFailure("SessionNotValid");
  stub.login = dexcomFailure("AccountPasswordInvalid");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await expect(page.locator("#setup")).toBeVisible();
  await expect(page.locator("#setup-error")).toContainText("Dexcom rejected the login");
  await expect(page.locator("#setup-username")).toHaveValue("sharer@example.com");
  await expect(page.locator("#banner")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("cgm.creds"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("cgm.account"))).toBeNull();
  expect(stub.calls).toEqual({ auth: 1, login: 2, read: 2 });

  await page.clock.runFor(10 * 60_000);
  await page.waitForTimeout(150);
  expect(stub.calls).toEqual({ auth: 1, login: 2, read: 2 });
});

test("a lockout mid-run returns to setup and stops the loop", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");

  stub.read = dexcomFailure("SessionNotValid");
  stub.login = dexcomFailure("SSO_AuthenticateMaxAttemptsExceeded");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await expect(page.locator("#setup-error")).toContainText("locked the account");
  await page.clock.runFor(10 * 60_000);
  await page.waitForTimeout(150);
  expect(stub.calls).toEqual({ auth: 1, login: 2, read: 2 });
});

test("a server error during a session refresh keeps the account id and waits", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");

  stub.read = dexcomFailure("SessionNotValid");
  stub.login = () => ({ status: 503, body: "<html>unavailable</html>" });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await expect(page.locator("#banner")).toHaveText("NO DATA");
  await expect(page.locator("#setup")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("cgm.account"))).not.toBeNull();
  await page.waitForTimeout(150);
  await page.clock.runFor(55_000);
  await page.waitForTimeout(150);
  expect(stub.calls).toEqual({ auth: 1, login: 2, read: 2 });
});

test("double-tapping the corner forgets the credentials but keeps the username", async ({ page }) => {
  await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#setup")).toBeHidden();

  await page.locator("#reset-zone").dblclick();

  await expect(page.locator("#setup")).toBeVisible();
  await expect(page.locator("#setup-username")).toHaveValue("sharer@example.com");
  await expect(page.locator("#setup-password")).toBeFocused();
  await expect(page.locator("#glucose")).toHaveText("---");
  expect(await page.evaluate(() => localStorage.getItem("cgm.creds"))).toBeNull();
});

test("the next fetch waits for the reading that is due, then retries every 5 s", async ({ page }) => {
  const stub = await stubDexcom(page);
  await page.goto("/");
  await connect(page);
  await expect(page.locator("#glucose")).toHaveText("16.9");
  const expectReads = async (n: number) => {
    await expect.poll(() => stub.calls.read).toBe(n);
    await page.waitForTimeout(150);
  };

  await page.clock.runFor(179_000);
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

test("stored credentials fetch immediately and show the tap-to-start gate on touch devices", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 956, height: 440 } });
  const page = await context.newPage();
  await freezeClock(page);
  await stubDexcom(page);
  await page.addInitScript(() => localStorage.setItem("cgm.creds", JSON.stringify({ username: "u", password: "p", server: "ous" })));
  await page.goto("/");

  await expect(page.locator("#setup")).toBeHidden();
  await expect(page.locator("#overlay")).toBeVisible();
  await expect(page.locator("#glucose")).toHaveText("16.9");
  await page.locator("#overlay").tap();
  await expect(page.locator("#overlay")).toBeHidden();
  await context.close();
});
