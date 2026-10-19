import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../dexcom-client.js";

const APP_ID_DEFAULT = "d89443d2-327c-4a6f-89e5-496bbb0317db";
const APP_ID_JP = "d8665ade-9673-4e27-9ff6-92db4ce13d13";
const NIL_GUID = "00000000-0000-0000-0000-000000000000";
const AUTH_URL = "https://shareous1.dexcom.com/ShareWebServices/Services/General/AuthenticatePublisherAccount";
const LOGIN_URL = "https://shareous1.dexcom.com/ShareWebServices/Services/General/LoginPublisherAccountById";
const READ_URL = "https://shareous1.dexcom.com/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues";

const fetchMock = vi.fn();
const creds = { username: "user@example.com", password: "secret", server: "ous" as const };
const readParams = { ...creds, minutes: 180, maxCount: 36 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function dexcomFailure(code: string): Response {
  return json({ Code: code, Message: "nope", SubCode: "{}" }, 500);
}

function call(i: number): { url: string; init: RequestInit; body: unknown } {
  const [url, init] = fetchMock.mock.calls[i] as [URL | string, RequestInit];
  return { url: String(url), init, body: init.body ? JSON.parse(init.body as string) : undefined };
}

function cacheSession(id: string, ageMs = 1000, server = "ous", username = creds.username) {
  localStorage.setItem("cgm.session", JSON.stringify({ id, username, server, createdAt: Date.now() - ageMs }));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authenticate", () => {
  it("POSTs straight to the regional Dexcom host and returns the account GUID", async () => {
    fetchMock.mockResolvedValueOnce(json("acct-guid-1"));

    await expect(client.authenticate(creds)).resolves.toBe("acct-guid-1");

    const { url, init, body } = call(0);
    expect(url).toBe(AUTH_URL);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(body).toEqual({ accountName: "user@example.com", password: "secret", applicationId: APP_ID_DEFAULT });
  });

  it("uses the Japan host and applicationId for 'jp'", async () => {
    fetchMock.mockResolvedValueOnce(json("acct-jp"));

    await client.authenticate({ ...creds, server: "jp" });

    const { url, body } = call(0);
    expect(url).toMatch(/^https:\/\/share\.dexcom\.jp\//);
    expect((body as { applicationId: string }).applicationId).toBe(APP_ID_JP);
  });

  it("uses share2 for 'us'", async () => {
    fetchMock.mockResolvedValueOnce(json("acct-us"));

    await client.authenticate({ ...creds, server: "us" });

    expect(call(0).url).toMatch(/^https:\/\/share2\.dexcom\.com\//);
  });

  it("rejects unknown and prototype-named regions without calling fetch", async () => {
    for (const server of ["eu", "__proto__", "constructor"]) {
      await expect(client.authenticate({ ...creds, server })).rejects.toThrow(/unknown server/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats the nil GUID as invalid credentials", async () => {
    fetchMock.mockResolvedValueOnce(json(NIL_GUID));

    const err = await client.authenticate(creds).catch((e) => e);

    expect(err).toBeInstanceOf(client.DexcomError);
    expect(err.code).toBe("InvalidCredentials");
    expect(err.isAuthError).toBe(true);
  });

  it("surfaces Dexcom's error code from a 500 body", async () => {
    fetchMock.mockResolvedValueOnce(dexcomFailure("AccountPasswordInvalid"));

    const err = await client.authenticate(creds).catch((e) => e);

    expect(err.code).toBe("AccountPasswordInvalid");
    expect(err.status).toBe(500);
    expect(err.isAuthError).toBe(true);
    expect(err.isLocked).toBe(false);
  });

  it("flags the lockout code", async () => {
    fetchMock.mockResolvedValueOnce(dexcomFailure("SSO_AuthenticateMaxAttemptsExceeded"));

    const err = await client.authenticate(creds).catch((e) => e);

    expect(err.isLocked).toBe(true);
    expect(err.isAuthError).toBe(true);
  });

  it("wraps non-JSON failures as HttpError", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));

    const err = await client.authenticate(creds).catch((e) => e);

    expect(err.code).toBe("HttpError");
    expect(err.isAuthError).toBe(false);
    expect(err.isSessionError).toBe(false);
  });

  it("wraps a bare JSON string failure as HttpError", async () => {
    fetchMock.mockResolvedValueOnce(json("Something broke", 500));

    const err = await client.authenticate(creds).catch((e) => e);

    expect(err.code).toBe("HttpError");
  });

  it("treats SSO_InternalError as auth failure only for the account-lookup messages", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Code: "SSO_InternalError", Message: "Cannot Authenticate by AccountName" }, 500))
      .mockResolvedValueOnce(json({ Code: "SSO_InternalError", Message: "Cannot Authenticate by AccountId" }, 500))
      .mockResolvedValueOnce(json({ Code: "SSO_InternalError", Message: "Upstream timeout" }, 500));

    expect((await client.authenticate(creds).catch((e) => e)).isAuthError).toBe(true);
    expect((await client.authenticate(creds).catch((e) => e)).isAuthError).toBe(true);
    expect((await client.authenticate(creds).catch((e) => e)).isAuthError).toBe(false);
  });
});

describe("loginById", () => {
  it("POSTs LoginPublisherAccountById and returns the session GUID", async () => {
    fetchMock.mockResolvedValueOnce(json("session-guid-1"));

    await expect(client.loginById("acct-guid-1", creds)).resolves.toBe("session-guid-1");

    const { url, body } = call(0);
    expect(url).toBe(LOGIN_URL);
    expect(body).toEqual({ accountId: "acct-guid-1", password: "secret", applicationId: APP_ID_DEFAULT });
  });

  it("rejects a nil session GUID", async () => {
    fetchMock.mockResolvedValueOnce(json(NIL_GUID));

    await expect(client.loginById("acct", creds)).rejects.toMatchObject({ code: "InvalidCredentials" });
  });
});

describe("readReadings", () => {
  it("passes sessionId, minutes and maxCount as query params with no body", async () => {
    const readings = [{ Value: 120, Trend: 4, WT: "Date(1700000000000)" }];
    fetchMock.mockResolvedValueOnce(json(readings));

    await expect(client.readReadings("sid", { server: "ous", minutes: 180, maxCount: 36 })).resolves.toEqual(readings);

    const { url, init } = call(0);
    expect(url).toBe(`${READ_URL}?sessionId=sid&minutes=180&maxCount=36`);
    expect(init.body).toBeUndefined();
  });

  it("returns null for an empty 200 body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));

    await expect(client.readReadings("sid", { server: "ous", minutes: 180, maxCount: 36 })).resolves.toBeNull();
  });

  it("wraps a non-JSON 200 body, such as a captive portal, as a Dexcom error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>log in to the hotel wifi</html>", { status: 200 }));

    await expect(client.readReadings("sid", { server: "ous", minutes: 180, maxCount: 36 })).rejects.toMatchObject({ code: "InvalidJson" });
  });

  it("leaves undefined query values out of the URL and sends an abort signal", async () => {
    fetchMock.mockResolvedValueOnce(json([]));

    await client.readReadings("sid", { server: "ous", minutes: 180, maxCount: undefined as unknown as number });

    const { url, init } = call(0);
    expect(url).toBe(`${READ_URL}?sessionId=sid&minutes=180`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("getSession cache", () => {
  it("returns the cached session when fresh and does not call fetch", async () => {
    cacheSession("cached-session", 60_000);

    await expect(client.getSession(creds)).resolves.toBe("cached-session");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-authenticates after 1h and persists the new session", async () => {
    cacheSession("old-session", 3_600_001);
    fetchMock.mockResolvedValueOnce(json("acct-2")).mockResolvedValueOnce(json("new-session"));

    await expect(client.getSession(creds)).resolves.toBe("new-session");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const stored = JSON.parse(localStorage.getItem("cgm.session")!);
    expect(stored).toMatchObject({ id: "new-session", server: "ous" });
    expect(Date.now() - stored.createdAt).toBeLessThan(5_000);
  });

  it("does not cache a session when Dexcom answers with the nil GUID", async () => {
    fetchMock.mockResolvedValueOnce(json("acct")).mockResolvedValueOnce(json(NIL_GUID));

    await expect(client.getSession(creds)).rejects.toMatchObject({ code: "InvalidCredentials" });
    expect(localStorage.getItem("cgm.session")).toBeNull();
  });

  it("ignores a session stamped in the future, as after a clock change", async () => {
    cacheSession("future-session", -120_000);
    fetchMock.mockResolvedValueOnce(json("acct-f")).mockResolvedValueOnce(json("fresh"));

    await expect(client.getSession(creds)).resolves.toBe("fresh");
  });

  it("re-authenticates when the cached server differs", async () => {
    cacheSession("us-session", 0, "us");
    fetchMock.mockResolvedValueOnce(json("acct-3")).mockResolvedValueOnce(json("ous-session"));

    await expect(client.getSession(creds)).resolves.toBe("ous-session");
  });

  it("never reuses another account's session", async () => {
    cacheSession("their-session", 0, "ous", "someone@else.com");
    fetchMock.mockResolvedValueOnce(json("acct-4")).mockResolvedValueOnce(json("my-session"));

    await expect(client.getSession(creds)).resolves.toBe("my-session");
    expect(JSON.parse(localStorage.getItem("cgm.session")!)).toMatchObject({ id: "my-session", username: "user@example.com" });
  });
});

describe("getReadings", () => {
  it("re-authenticates and retries once on SessionNotValid", async () => {
    cacheSession("stale-session");
    const readings = [{ Value: 99, Trend: 4, WT: "Date(1)" }];
    fetchMock
      .mockResolvedValueOnce(dexcomFailure("SessionNotValid"))
      .mockResolvedValueOnce(json("acct-r"))
      .mockResolvedValueOnce(json("fresh-session"))
      .mockResolvedValueOnce(json(readings));

    await expect(client.getReadings(readParams)).resolves.toEqual(readings);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(call(3).url).toContain("sessionId=fresh-session");
  });

  it("retries on SessionIdNotFound too", async () => {
    cacheSession("stale-session");
    fetchMock
      .mockResolvedValueOnce(dexcomFailure("SessionIdNotFound"))
      .mockResolvedValueOnce(json("acct"))
      .mockResolvedValueOnce(json("s2"))
      .mockResolvedValueOnce(json([]));

    await expect(client.getReadings(readParams)).resolves.toEqual([]);
  });

  it("throws if the retry also fails", async () => {
    cacheSession("stale-session");
    fetchMock
      .mockResolvedValueOnce(dexcomFailure("SessionNotValid"))
      .mockResolvedValueOnce(json("acct"))
      .mockResolvedValueOnce(json("s2"))
      .mockResolvedValueOnce(dexcomFailure("SessionNotValid"));

    await expect(client.getReadings(readParams)).rejects.toMatchObject({ code: "SessionNotValid" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not retry auth on a password failure", async () => {
    fetchMock.mockResolvedValueOnce(dexcomFailure("AccountPasswordInvalid"));

    await expect(client.getReadings(readParams)).rejects.toMatchObject({ code: "AccountPasswordInvalid" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("cgm.session")).toBeNull();
  });

  it("does not retry a non-session 500", async () => {
    cacheSession("sid");
    fetchMock.mockResolvedValueOnce(dexcomFailure("InvalidArgument"));

    await expect(client.getReadings(readParams)).rejects.toMatchObject({ code: "InvalidArgument" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem("cgm.session")!).id).toBe("sid");
  });

  it("propagates network failures", async () => {
    cacheSession("sid");
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(client.getReadings(readParams)).rejects.toThrow(TypeError);
  });
});

describe("account id cache", () => {
  it("skips AuthenticatePublisherAccount once the account id is known", async () => {
    fetchMock.mockResolvedValueOnce(json("acct-1")).mockResolvedValueOnce(json("sess-1"));
    await client.getSession(creds);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    cacheSession("sess-1", 3_600_001);
    fetchMock.mockResolvedValueOnce(json("sess-2"));

    await expect(client.getSession(creds)).resolves.toBe("sess-2");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const { url, body } = call(2);
    expect(url).toBe(LOGIN_URL);
    expect(body).toEqual({ accountId: "acct-1", password: "secret", applicationId: APP_ID_DEFAULT });
  });

  it("ignores a cached account id for another username or region", async () => {
    localStorage.setItem("cgm.account", JSON.stringify({ username: "someone@else.com", server: "ous", accountId: "acct-x" }));
    fetchMock.mockResolvedValueOnce(json("acct-2")).mockResolvedValueOnce(json("sess-2"));

    await client.getSession(creds);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(0).url).toBe(AUTH_URL);
    expect(JSON.parse(localStorage.getItem("cgm.account")!)).toEqual({ username: "user@example.com", server: "ous", accountId: "acct-2" });
  });

  it("drops the cached account id when login with it fails on an auth error", async () => {
    localStorage.setItem("cgm.account", JSON.stringify({ username: "user@example.com", server: "ous", accountId: "acct-old" }));
    fetchMock.mockResolvedValueOnce(dexcomFailure("AccountPasswordInvalid"));

    await expect(client.getSession(creds)).rejects.toMatchObject({ code: "AccountPasswordInvalid" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("cgm.account")).toBeNull();
  });

  it("keeps the cached account id when login fails with a server error", async () => {
    localStorage.setItem("cgm.account", JSON.stringify({ username: "user@example.com", server: "ous", accountId: "acct-1" }));
    fetchMock.mockResolvedValueOnce(new Response("<html>unavailable</html>", { status: 503 }));

    await expect(client.getSession(creds)).rejects.toMatchObject({ code: "HttpError" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call(0).url).toBe(LOGIN_URL);
    expect(JSON.parse(localStorage.getItem("cgm.account")!).accountId).toBe("acct-1");
  });

  it("is cleared with the credentials", async () => {
    localStorage.setItem("cgm.account", JSON.stringify({ username: "user@example.com", server: "ous", accountId: "acct-1" }));

    client.clearCreds();

    expect(localStorage.getItem("cgm.account")).toBeNull();
  });
});

describe("credentials storage", () => {
  it("round-trips creds through localStorage", () => {
    expect(client.getCreds()).toBeNull();
    client.setCreds(creds);
    expect(client.getCreds()).toEqual(creds);
  });

  it("returns null for corrupt stored creds", () => {
    localStorage.setItem("cgm.creds", "{not json");
    expect(client.getCreds()).toBeNull();
  });

  it("clearCreds removes creds and session", () => {
    client.setCreds(creds);
    cacheSession("y");

    client.clearCreds();

    expect(localStorage.getItem("cgm.creds")).toBeNull();
    expect(localStorage.getItem("cgm.session")).toBeNull();
  });
});
