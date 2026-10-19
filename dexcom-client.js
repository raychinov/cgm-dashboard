const HOSTS = {
  us: "https://share2.dexcom.com",
  ous: "https://shareous1.dexcom.com",
  jp: "https://share.dexcom.jp",
};
const APP_IDS = {
  us: "d89443d2-327c-4a6f-89e5-496bbb0317db",
  ous: "d89443d2-327c-4a6f-89e5-496bbb0317db",
  jp: "d8665ade-9673-4e27-9ff6-92db4ce13d13",
};
const AUTH_PATH = "/ShareWebServices/Services/General/AuthenticatePublisherAccount";
const LOGIN_PATH = "/ShareWebServices/Services/General/LoginPublisherAccountById";
const READ_PATH = "/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues";

const NIL_GUID = "00000000-0000-0000-0000-000000000000";
const SESSION_CODES = new Set(["SessionIdNotFound", "SessionNotValid"]);
const LOCKED_CODE = "SSO_AuthenticateMaxAttemptsExceeded";
const AUTH_CODES = new Set([
  "AccountPasswordInvalid",
  "SSO_AuthenticateAccountNotFound",
  "AccountNotFound",
  "ApplicationNotAuthenticated",
  "InvalidCredentials",
  LOCKED_CODE,
]);
const SSO_AUTH_MESSAGE = /Cannot Authenticate by Account(Name|Id)/;

const SESSION_TTL_MS = 3_600_000;
const CREDS_KEY = "cgm.creds";
const SESSION_KEY = "cgm.session";
const ACCOUNT_KEY = "cgm.account";

export class DexcomError extends Error {
  constructor(code, message, status = 0) {
    super(`dexcom ${code}: ${message}`);
    this.name = "DexcomError";
    this.code = code;
    this.detail = message;
    this.status = status;
  }
  get isSessionError() {
    return SESSION_CODES.has(this.code);
  }
  get isAuthError() {
    if (this.code === "SSO_InternalError") return SSO_AUTH_MESSAGE.test(this.detail);
    return AUTH_CODES.has(this.code);
  }
  get isLocked() {
    return this.code === LOCKED_CODE;
  }
}

function errorFromResponse(status, text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.Code === "string") {
      return new DexcomError(parsed.Code, parsed.Message ?? "", status);
    }
  } catch {}
  return new DexcomError("HttpError", `${status} ${String(text).slice(0, 200)}`, status);
}

function regionValue(map, server) {
  if (!Object.prototype.hasOwnProperty.call(map, server)) throw new Error(`unknown server: ${server}`);
  return map[server];
}

const REQUEST_TIMEOUT_MS = 15_000;

async function callDexcom(server, path, { body, query } = {}) {
  const url = new URL(path, regionValue(HOSTS, server));
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  let res, text;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abort.signal,
    });
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw errorFromResponse(res.status, text);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new DexcomError("InvalidJson", text.slice(0, 200), res.status);
  }
}

function requireGuid(value, what) {
  if (typeof value !== "string" || value === NIL_GUID) {
    throw new DexcomError("InvalidCredentials", `Dexcom returned no ${what}`);
  }
  return value;
}

export async function authenticate({ username, password, server }) {
  const body = { accountName: username, password, applicationId: regionValue(APP_IDS, server) };
  return requireGuid(await callDexcom(server, AUTH_PATH, { body }), "account id");
}

export async function loginById(accountId, { password, server }) {
  const body = { accountId, password, applicationId: regionValue(APP_IDS, server) };
  return requireGuid(await callDexcom(server, LOGIN_PATH, { body }), "session id");
}

export async function readReadings(sessionId, { server, minutes, maxCount }) {
  return callDexcom(server, READ_PATH, { query: { sessionId, minutes, maxCount } });
}

function readJson(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function invalidateSession() {
  localStorage.removeItem(SESSION_KEY);
}

function cachedAccountId(creds) {
  const account = readJson(ACCOUNT_KEY);
  return account && account.username === creds.username && account.server === creds.server ? account.accountId : null;
}

export async function getSession(creds) {
  const cached = readJson(SESSION_KEY);
  const age = cached ? Date.now() - cached.createdAt : -1;
  if (cached && cached.username === creds.username && cached.server === creds.server && age >= 0 && age < SESSION_TTL_MS) {
    return cached.id;
  }
  const knownAccountId = cachedAccountId(creds);
  const accountId = knownAccountId ?? (await authenticate(creds));
  let sessionId;
  try {
    sessionId = await loginById(accountId, creds);
  } catch (err) {
    if (knownAccountId && err instanceof DexcomError && err.isAuthError) localStorage.removeItem(ACCOUNT_KEY);
    throw err;
  }
  localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ username: creds.username, server: creds.server, accountId }));
  localStorage.setItem(SESSION_KEY, JSON.stringify({ id: sessionId, username: creds.username, server: creds.server, createdAt: Date.now() }));
  return sessionId;
}

export async function getReadings(creds) {
  const sessionId = await getSession(creds);
  try {
    return await readReadings(sessionId, creds);
  } catch (err) {
    if (!(err instanceof DexcomError && err.isSessionError)) throw err;
    invalidateSession();
  }
  return readReadings(await getSession(creds), creds);
}

export function getCreds() {
  return readJson(CREDS_KEY);
}

export function setCreds(creds) {
  localStorage.setItem(CREDS_KEY, JSON.stringify(creds));
}

export function clearCreds() {
  localStorage.removeItem(CREDS_KEY);
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(ACCOUNT_KEY);
}
