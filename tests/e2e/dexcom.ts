import { test as base, type Page, type Route } from "@playwright/test";

export const BASE_TIME = new Date("2026-10-19T14:00:00").getTime();
export const DEXCOM_URL = /https:\/\/share(2|ous1)\.dexcom\.com\/|https:\/\/share\.dexcom\.jp\//;
export const APP_ID_US = "d89443d2-327c-4a6f-89e5-496bbb0317db";

type Trend = number | string;
type ReadingSpec = [minutesAgo: number, mgdl: number, trend: Trend];

export const RISING: ReadingSpec[] = [
  [2, 305, 2], [7, 260, 3], [12, 210, 3], [17, 175, 4], [22, 150, 4], [27, 120, 4],
  [32, 95, 4], [37, 88, 4], [42, 92, 4], [47, 100, 4], [60, 110, 4], [75, 118, 4],
  [90, 105, 5], [105, 92, 5], [120, 78, 6], [135, 65, 6], [150, 70, 4], [165, 84, 3],
];

export const WIDE: ReadingSpec[] = [[59, 400, 7], [64, 621, 7], [69, 580, 7], [74, 500, 6], [120, 300, 4], [170, 200, 4]];

export const CALM: ReadingSpec[] = [
  [3, 118, 4], [8, 121, 4], [13, 126, 4], [18, 133, 5], [23, 141, 5], [28, 150, 5], [33, 158, 4], [38, 161, 4],
  [43, 159, 4], [48, 152, 3], [53, 144, 3], [58, 137, 3], [63, 131, 4], [73, 127, 4], [83, 124, 4], [93, 120, 4],
  [103, 116, 4], [113, 112, 4], [123, 108, 4], [133, 104, 4], [143, 99, 4], [153, 95, 4], [163, 93, 4], [173, 94, 4],
];

export function readings(specs: ReadingSpec[], now = BASE_TIME) {
  return specs.map(([min, mgdl, trend]) => ({ WT: `/Date(${now - min * 60_000})/`, Value: mgdl, Trend: trend }));
}

type Reply = () => { status: number; body: unknown };
type Kind = "auth" | "login" | "read";

export type DexcomStub = {
  auth: Reply;
  login: Reply;
  read: Reply;
  calls: Record<Kind, number>;
  requests: { kind: Kind; host: string; body: unknown; query: Record<string, string> }[];
};

const ok = (body: unknown): Reply => () => ({ status: 200, body });
export const dexcomFailure = (code: string): Reply => () => ({ status: 500, body: { Code: code, Message: "nope" } });

export async function stubDexcom(page: Page, overrides: Partial<Pick<DexcomStub, Kind>> = {}): Promise<DexcomStub> {
  const stub: DexcomStub = {
    auth: ok("11111111-1111-1111-1111-111111111111"),
    login: ok("22222222-2222-2222-2222-222222222222"),
    read: ok(readings(RISING)),
    calls: { auth: 0, login: 0, read: 0 },
    requests: [],
    ...overrides,
  };
  await page.route(DEXCOM_URL, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const kind: Kind = url.pathname.includes("AuthenticatePublisherAccount") ? "auth" : url.pathname.includes("LoginPublisherAccountById") ? "login" : "read";
    stub.calls[kind]++;
    stub.requests.push({ kind, host: url.host, body: req.postData() ? req.postDataJSON() : undefined, query: Object.fromEntries(url.searchParams) });
    const { status, body } = stub[kind]();
    return route.fulfill({ status, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  });
  return stub;
}

export async function connect(page: Page, { username = "sharer@example.com", password = "pw", server = "ous" } = {}) {
  await page.fill("#setup-username", username);
  await page.fill("#setup-password", password);
  await page.selectOption("#setup-server", server);
  await page.click("#setup-save");
}

export async function freezeClock(page: Page, time = BASE_TIME) {
  await page.clock.install({ time: time - 1_000 });
  await page.clock.pauseAt(time);
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route(DEXCOM_URL, (route) => route.abort());
    await use(page);
  },
});

export const LANDSCAPE_VIEWPORTS = [
  "568x320", "667x375", "740x360", "844x390", "915x412", "956x440",
  "1024x768", "1180x820",
].map((vp) => ({ name: vp, width: Number(vp.split("x")[0]), height: Number(vp.split("x")[1]) }));
