
import { looksLikeSeedPlaceholder } from "@/services/provisioning/seed-markers";
import { readSiteMeta } from "@/services/sites/site-content-check";
import { createHmac, randomUUID } from "node:crypto";

export type Invariant = { name: string; pass: boolean; evidence: string; smoke?: boolean };

export type AcceptanceBatteryResult = {
  pass: boolean;
  invariants: Invariant[];
  firstFailure: string;
};

export type ProbeHeaders = {
  get(name: string): string | null;
  getSetCookie?(): string[];
};
export type ProbeResponse = {
  status: number;
  headers: ProbeHeaders;
  text(): Promise<string>;
};
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: "manual" | "follow";
  },
) => Promise<ProbeResponse>;

const BROWSE_ROUTES = [
  "/browse", "/listings", "/search", "/explore", "/products", "/marketplace",
  "/items", "/catalog", "/services", "/providers", "/shop", "/feed",
] as const;
const PROTECTED_ROUTES = [
  "/dashboard", "/account", "/app", "/home", "/profile", "/settings", "/admin",
  "/my", "/me", "/inbox",
] as const;
const AMBIGUOUS_PUBLIC_ROUTES: ReadonlySet<string> = new Set(["/home", "/app"]);
const SIGNUP_ENDPOINTS = [
  "/api/signup", "/api/auth/signup", "/api/auth/sign-up", "/api/register",
  "/api/auth/register", "/api/users", "/api/user", "/signup", "/register",
  "/api/sign-up", "/api/account",
] as const;
const SIGNUP_ROUTE_HANDLERS: ReadonlySet<string> = new Set([
  "/api/signup", "/api/auth/signup", "/api/auth/sign-up", "/api/register", "/api/auth/register", "/api/sign-up",
]);
const SERVER_ERROR_LOCATION_RE = /[?&]error=server(?:&|$)/;
const API_SCAN_PAGES = [
  "/book", "/booking", "/bookings", "/schedule", "/appointments", "/reserve", "/order",
] as const;
const API_PATH_RE = /["'`](\/api\/[A-Za-z0-9_\-/]+)([$[:{]?)/g;
const API_SKIP_WORDS: ReadonlySet<string> = new Set([
  "signup", "signin", "login", "logout", "register", "auth", "oauth", "session", "callback", "token",
  "password", "verify", "invite", "webhook", "webhooks", "stripe", "checkout", "cron", "notify", "send",
  "seed", "reset", "delete", "cancel", "confirm", "email", "sms", "charge", "pay", "payment", "payments",
  "subscribe", "unsubscribe", "admin",
]);
const API_PARAM_TAIL_RE = /\/id$/i;
const SCRIPT_SRC_RE = /<script[^>]+src=["'](\/_next\/static\/[^"']+\.js)["']/gi;
const MAX_API_PROBES = 8;
const MAX_SCRIPT_SCANS = 12;
const TRANSIENT_5XX: ReadonlySet<number> = new Set([502, 503, 504]);
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 2000;
const POST_CALL_RE = /["'`](\/api\/[A-Za-z0-9_\-/]+)["'`]\s*,\s*\{[^;()]{0,300}?method\s*:\s*["'`]POST["'`]/gi;
const AXIOS_POST_RE = /\.post\(\s*["'`](\/api\/[A-Za-z0-9_\-/]+)["'`]/gi;
const FORM_TAG_RE = /<form\b[^>]*>/gi;
const AVAILABILITY_WORDS: ReadonlySet<string> = new Set([
  "availability", "available", "slots", "slot", "times", "timeslots", "openings", "schedule",
]);
const BOOKING_WORDS: ReadonlySet<string> = new Set([
  "book", "booking", "bookings", "appointment", "appointments", "reservation", "reservations", "reserve",
  "sessions", "lessons",
]);
const SLOT_KEYS = [
  "start", "startTime", "start_time", "startsAt", "starts_at", "start_at", "datetime", "dateTime", "time", "slot",
] as const;
const TAKEN_KEY_RE = /book|taken|unavail|blocked|busy|reserved|closed/i;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const CLOCK_TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?(\s?[AaPp][Mm])?$/;
const PERSON_WORDS: ReadonlySet<string> = new Set([
  "user", "users", "owner", "owners", "admin", "admins", "member", "members", "account", "accounts",
  "profile", "profiles", "me", "staff", "team", "customer", "customers",
]);
const BOOKING_SEARCH_DAYS = 7;
export const SMOKE_TEST_NAME = "Zavi smoke test";
export const SMOKE_TEST_EMAIL = "zavi-smoke-test@zavi.invalid";
const SMOKE_TEST_NOTE = "Automated Zavi smoke test booking. Safe to delete.";
const SESSION_COOKIE_NAMES = [
  "session", "token", "auth", "sid", "connect.sid", "__session", "access_token",
  "jwt", "authToken", "sessionToken", "app_session", "auth_token",
] as const;

function defaultSecrets(appSlug: string): string[] {
  const slug = (appSlug || "app").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "app";
  return [
    `${slug}-dev-secret-change-me`,
    `${slug}-secret`,
    `${slug}-session-secret`,
    "dev-secret-change-me",
    "change-me",
    "changeme",
    "secret",
    "supersecret",
    "your-secret-here",
    "session-secret",
    "please-change-me",
    "keyboard cat",
    "insecure-secret",
  ];
}

type Probe = {
  reached: boolean;
  status: number;
  body: string;
  location: string | null;
  cookie: string | null;
};

const NET_FAIL: Probe = { reached: false, status: -1, body: "", location: null, cookie: null };

function firstSetCookiePair(headers: ProbeHeaders): string | null {
  let raw: string | null = null;
  if (typeof headers.getSetCookie === "function") {
    const all = headers.getSetCookie();
    if (Array.isArray(all) && all.length > 0) raw = all[0];
  }
  if (raw === null) raw = headers.get("set-cookie");
  if (!raw) return null;
  const pair = raw.split(";", 1)[0]?.trim();
  return pair && pair.includes("=") ? pair : null;
}

function cookieName(pair: string | null): string | null {
  if (!pair) return null;
  const eq = pair.indexOf("=");
  return eq > 0 ? pair.slice(0, eq) : null;
}

async function safeFetch(
  fetchImpl: FetchLike,
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    readBody?: boolean;
  } = {},
): Promise<Probe> {
  try {
    const res = await fetchImpl(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      redirect: "manual",
    });
    const body = init.readBody ? await res.text().catch(() => "") : "";
    return {
      reached: true,
      status: res.status,
      body,
      location: res.headers.get("location"),
      cookie: firstSetCookiePair(res.headers),
    };
  } catch {
    return NET_FAIL;
  }
}

const isRedirect = (s: number) => s >= 300 && s < 400;
const is2xx = (s: number) => s >= 200 && s < 300;
const isLoginLocation = (loc: string | null): boolean =>
  typeof loc === "string" && /login|sign-?in/i.test(loc);
const isGated = (p: Probe): boolean =>
  p.reached && ((p.status === 401 || p.status === 403) || (isRedirect(p.status) && isLoginLocation(p.location)));

function titleOf(body: string): string | null {
  const m = body.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : null;
}

const trunc = (s: string, n = 300): string => (s.length > n ? s.slice(0, n) : s);

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function forgedCookieValues(appSlug: string): string[] {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    uid: 1, sub: "1", id: 1, userId: 1, user_id: 1,
    email: "acceptance-probe@zavi.invalid", role: "user",
    iat: now, exp: now + 3600,
  };
  const payloadJson = JSON.stringify(claims);
  const values: string[] = [];

  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(payloadJson);
  for (const secret of defaultSecrets(appSlug)) {
    const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    values.push(`${header}.${payload}.${sig}`);
  }
  const b64payload = b64url(payloadJson);
  for (const secret of defaultSecrets(appSlug).slice(0, 6)) {
    const sig = createHmac("sha256", secret).update(b64payload).digest("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    values.push(`${b64payload}.${sig}`);
  }
  values.push(encodeURIComponent(payloadJson));
  values.push(b64url(payloadJson));
  values.push("1");
  return values;
}

export type SmokeCheckContext = { baseUrl: string; fetch: FetchLike };
export type SmokeCheck = (ctx: SmokeCheckContext) => Promise<Invariant>;

export type RunAcceptanceBatteryInput = {
  baseUrl: string;
  appSlug?: string;
  smokeGate?: boolean;
  claimBookingSmoke?: () => Promise<boolean>;
  transientRetryDelayMs?: number;
  ownerLoginCheck?: SmokeCheck;
  starterDetailsCheck?: boolean;
};

export const STARTER_APP_TITLE = "Your Company";
export const STARTER_APP_DESCRIPTION = "A starter app, provisioned and ready to build on.";

export function starterDetailsInvariant(home: { reached: boolean; status: number; body: string }): Invariant {
  const name = "STARTER_DETAILS";
  if (!home.reached || !is2xx(home.status)) {
    return { name, pass: true, evidence: trunc(`GET / -> ${home.status}; page details not checked`), smoke: true };
  }
  const { title, description } = readSiteMeta(home.body);
  const kept: string[] = [];
  if ((title ?? "").toLowerCase() === STARTER_APP_TITLE.toLowerCase()) kept.push(`the starter title "${STARTER_APP_TITLE}"`);
  if ((description ?? "").toLowerCase() === STARTER_APP_DESCRIPTION.toLowerCase()) kept.push("the starter description");
  if (kept.length === 0) return { name, pass: true, evidence: trunc(`title=${title ?? "(none)"}`), smoke: true };
  return {
    name,
    pass: false,
    evidence: trunc(`the home page still has ${kept.join(" and ")}; set the site's own title and description in app/layout.tsx metadata`),
    smoke: true,
  };
}

function apiPathsIn(text: string): Array<{ path: string; needsParams: boolean }> {
  const out: Array<{ path: string; needsParams: boolean }> = [];
  for (const m of text.matchAll(API_PATH_RE)) {
    const path = m[1].replace(/\/+$/, "");
    if (path.length <= "/api".length) continue;
    out.push({ path, needsParams: m[2] !== "" || m[1].endsWith("/") || API_PARAM_TAIL_RE.test(path) });
  }
  return out;
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter(Boolean).slice(1);
}

function segmentHasWord(segment: string, words: ReadonlySet<string>): boolean {
  const lower = segment.toLowerCase();
  if (words.has(lower.replace(/[-_.]/g, ""))) return true;
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .split(/[-_.]/)
    .some((w) => words.has(w));
}

const routeHasWord = (path: string, words: ReadonlySet<string>): boolean =>
  segmentsOf(path).some((seg) => segmentHasWord(seg, words));

function probeableApiRoutes(texts: string[]): string[] {
  const needsParams = new Map<string, boolean>();
  for (const { path, needsParams: np } of texts.flatMap(apiPathsIn)) {
    needsParams.set(path, (needsParams.get(path) ?? true) && np);
  }
  return [...needsParams.entries()]
    .filter(([path, np]) => !np && !routeHasWord(path, API_SKIP_WORDS))
    .map(([path]) => path);
}

function scriptSrcsIn(html: string): string[] {
  return [...html.matchAll(SCRIPT_SRC_RE)].map((m) => m[1]);
}

type ApiScan = { texts: string[]; routes: string[] };

async function scanApi(fetchImpl: FetchLike, base: string, homeBody: string): Promise<ApiScan> {
  const pages = [homeBody];
  for (const r of API_SCAN_PAGES) {
    const p = await safeFetch(fetchImpl, `${base}${r}`, { readBody: true });
    if (p.reached && is2xx(p.status)) pages.push(p.body);
  }
  const scripts = [...new Set(pages.flatMap(scriptSrcsIn))].slice(0, MAX_SCRIPT_SCANS);
  const texts = [...pages];
  for (const src of scripts) {
    const p = await safeFetch(fetchImpl, `${base}${src}`, { readBody: true });
    if (p.reached && is2xx(p.status)) texts.push(p.body);
  }
  return { texts, routes: probeableApiRoutes(texts).slice(0, MAX_API_PROBES) };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function probeRetryingTransient(fetchImpl: FetchLike, url: string, delayMs: number): Promise<Probe> {
  const first = await safeFetch(fetchImpl, url, { readBody: true });
  if (!first.reached || !TRANSIENT_5XX.has(first.status)) return first;
  await sleep(delayMs);
  return safeFetch(fetchImpl, url, { readBody: true });
}

const isServerError = (p: Probe): boolean => p.reached && p.status >= 500;

async function probeApiRoutes(
  fetchImpl: FetchLike,
  base: string,
  scan: ApiScan,
  date: string,
  delayMs: number,
): Promise<{ invariant: Invariant; results: Map<string, Probe> }> {
  const results = new Map<string, Probe>();
  const { routes } = scan;
  if (routes.length === 0) {
    return {
      invariant: { name: "NO_500_API", pass: true, smoke: true, evidence: "no /api route found in the app's pages — api not asserted" },
      results,
    };
  }
  const broken: string[] = [];
  for (const r of routes) {
    const p = await probeRetryingTransient(fetchImpl, `${base}${r}?date=${date}`, delayMs);
    results.set(r, p);
    if (isServerError(p)) broken.push(`GET ${r}?date=${date} -> ${p.status}`);
  }
  return {
    invariant: {
      name: "NO_500_API",
      pass: broken.length === 0,
      smoke: true,
      evidence: trunc(
        broken.length === 0
          ? `probed ${routes.length} api route(s): ${routes.join(", ")} — none 5xx`
          : `api route(s) the app's own pages call return a server error: ${broken.join("; ")}`,
      ),
    },
    results,
  };
}

function postRoutesIn(texts: string[]): string[] {
  const out = new Set<string>();
  const add = (path: string) => out.add(path.replace(/\/+$/, ""));
  for (const t of texts) {
    for (const m of t.matchAll(POST_CALL_RE)) add(m[1]);
    for (const m of t.matchAll(AXIOS_POST_RE)) add(m[1]);
    for (const m of t.matchAll(FORM_TAG_RE)) {
      const action = m[0].match(/\baction=["'](\/api\/[A-Za-z0-9_\-/]+)["']/i);
      if (action && /\bmethod=["']?post\b/i.test(m[0])) add(action[1]);
    }
  }
  return [...out];
}

type Slot = { value: string; fields: Record<string, string | number | boolean> };

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function slotValue(v: unknown): string | null {
  return typeof v === "string" && (ISO_DATETIME_RE.test(v) || CLOCK_TIME_RE.test(v.trim())) ? v.trim() : null;
}

function isTaken(o: Record<string, unknown>): boolean {
  return (
    o.available === false || o.isAvailable === false || o.is_available === false ||
    o.booked === true || o.isBooked === true || o.is_booked === true || o.taken === true
  );
}

function slotFields(o: Record<string, unknown>): Slot["fields"] {
  const out: Slot["fields"] = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
    if (k === "id") {
      out.slotId = v;
      out.slot_id = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function findSlot(node: unknown, depth = 0): Slot | null {
  if (depth > 5) return null;
  const direct = slotValue(node);
  if (direct) return { value: direct, fields: {} };
  if (Array.isArray(node)) {
    for (const item of node) {
      const s = findSlot(item, depth + 1);
      if (s) return s;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const o = node as Record<string, unknown>;
  if (isTaken(o)) return null;
  for (const k of SLOT_KEYS) {
    const v = slotValue(o[k]);
    if (v) return { value: v, fields: slotFields(o) };
  }
  for (const [k, v] of Object.entries(o)) {
    if (TAKEN_KEY_RE.test(k) || !v || typeof v !== "object") continue;
    const s = findSlot(v, depth + 1);
    if (s) return s;
  }
  return null;
}

function firstRecord(json: unknown): Record<string, unknown> | null {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === "object"
      ? Object.values(json as Record<string, unknown>).find(Array.isArray)
      : null;
  const first: unknown = Array.isArray(list) ? list[0] : null;
  return first && typeof first === "object" && !Array.isArray(first) ? (first as Record<string, unknown>) : null;
}

function contextIds(results: Map<string, Probe>, exclude: string[]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [route, p] of results) {
    if (exclude.includes(route) || !p.reached || !is2xx(p.status) || routeHasWord(route, PERSON_WORDS)) continue;
    const id = firstRecord(parseJson(p.body))?.id;
    if (typeof id !== "string" && typeof id !== "number") continue;
    const segs = segmentsOf(route);
    const last = (segs[segs.length - 1] ?? "").toLowerCase();
    if (!/^[a-z]+$/.test(last)) continue;
    const singular = last.endsWith("ies") ? `${last.slice(0, -3)}y` : last.endsWith("s") ? last.slice(0, -1) : last;
    out[`${singular}Id`] = id;
    out[`${singular}_id`] = id;
  }
  return out;
}

function bookingPayload(date: string, slot: Slot, ids: Record<string, string | number>): Record<string, unknown> {
  const iso = ISO_DATETIME_RE.test(slot.value);
  const day = iso ? slot.value.slice(0, 10) : date;
  const clock = iso ? slot.value.slice(11, 16) : slot.value;
  const at = iso ? slot.value : `${date}T${clock}`;
  return {
    ...ids,
    date: day,
    time: clock,
    slot: slot.value,
    startTime: iso ? at : clock,
    start_time: iso ? at : clock,
    start: at,
    startsAt: at,
    starts_at: at,
    datetime: at,
    ...slot.fields,
    name: SMOKE_TEST_NAME,
    customerName: SMOKE_TEST_NAME,
    customer_name: SMOKE_TEST_NAME,
    fullName: SMOKE_TEST_NAME,
    full_name: SMOKE_TEST_NAME,
    email: SMOKE_TEST_EMAIL,
    customerEmail: SMOKE_TEST_EMAIL,
    customer_email: SMOKE_TEST_EMAIL,
    notes: SMOKE_TEST_NOTE,
    note: SMOKE_TEST_NOTE,
  };
}

function echoesSmokeBooking(o: Record<string, unknown>): boolean {
  return Object.values(o).some((v) => v === SMOKE_TEST_EMAIL || v === SMOKE_TEST_NAME || v === SMOKE_TEST_NOTE);
}

function createdId(body: string, slot: Slot): string | number | null {
  const json = parseJson(body);
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const root = json as Record<string, unknown>;
  const slotIds = new Set([slot.fields.slotId, slot.fields.slot_id].filter((v) => v !== undefined).map(String));
  const candidates: Array<[unknown, boolean]> = [
    [root.booking, true],
    [root.appointment, true],
    [root.reservation, true],
    [root.data, false],
    [root, false],
  ];
  for (const [c, named] of candidates) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const o = c as Record<string, unknown>;
    const id = o.id;
    if (typeof id !== "string" && typeof id !== "number") continue;
    if (slotIds.has(String(id))) continue;
    if (named || echoesSmokeBooking(o)) return id;
  }
  return null;
}

async function cleanUpBooking(fetchImpl: FetchLike, base: string, route: string, body: string, slot: Slot): Promise<string> {
  const id = createdId(body, slot);
  if (id === null) return "no id returned, test booking left in place";
  const del = await safeFetch(fetchImpl, `${base}${route}/${encodeURIComponent(String(id))}`, {
    method: "DELETE",
    headers: { "x-zavi-smoke-test": "1" },
  });
  return del.reached && is2xx(del.status)
    ? "test booking deleted"
    : `DELETE ${route}/:id -> ${del.status}, test booking left in place`;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

async function bookingSmoke(
  fetchImpl: FetchLike,
  base: string,
  scan: ApiScan,
  results: Map<string, Probe>,
  date: string,
  delayMs: number,
  claim: (() => Promise<boolean>) | undefined,
): Promise<Invariant | null> {
  const availability = scan.routes.find((r) => routeHasWord(r, AVAILABILITY_WORDS));
  const booking = postRoutesIn(scan.texts).find(
    (r) => routeHasWord(r, BOOKING_WORDS) && !routeHasWord(r, AVAILABILITY_WORDS) && !routeHasWord(r, API_SKIP_WORDS),
  );
  if (!availability || !booking) return null;
  const name = "BOOKING_SMOKE";
  let slot: Slot | null = null;
  let slotDate = date;
  for (let i = 0; i < BOOKING_SEARCH_DAYS && !slot; i++) {
    const day = addDays(date, i);
    const cached = i === 0 ? results.get(availability) : undefined;
    const p = cached ?? (await probeRetryingTransient(fetchImpl, `${base}${availability}?date=${day}`, delayMs));
    if (isServerError(p)) {
      return {
        name,
        pass: false,
        smoke: true,
        evidence: trunc(`GET ${availability}?date=${day} -> ${p.status}, so nobody can pick a time to book`),
      };
    }
    if (!p.reached || !is2xx(p.status)) break;
    slot = findSlot(parseJson(p.body));
    slotDate = day;
  }
  if (!slot) {
    return {
      name,
      pass: true,
      smoke: true,
      evidence: trunc(`booking flow ${availability} -> POST ${booking} found, no open slot offered in ${BOOKING_SEARCH_DAYS} days — booking not attempted`),
    };
  }
  if (!claim) {
    return {
      name,
      pass: true,
      smoke: true,
      evidence: trunc(`GET ${availability}?date=${slotDate} offered a slot; test booking not attempted (build_booking_smoke off, or not a first build)`),
    };
  }
  if (!(await claim())) {
    return {
      name,
      pass: true,
      smoke: true,
      evidence: trunc(`GET ${availability}?date=${slotDate} offered a slot; test booking already attempted for this build, not repeated`),
    };
  }
  const post = await safeFetch(fetchImpl, `${base}${booking}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zavi-smoke-test": "1" },
    body: JSON.stringify(bookingPayload(slotDate, slot, contextIds(results, [availability, booking]))),
    readBody: true,
  });
  if (!post.reached || TRANSIENT_5XX.has(post.status)) {
    return {
      name,
      pass: true,
      smoke: true,
      evidence: trunc(`POST ${booking} -> ${post.status} (unreachable or transient, not retried so no second booking) — inconclusive`),
    };
  }
  if (post.status >= 500) {
    return {
      name,
      pass: false,
      smoke: true,
      evidence: trunc(`POST ${booking} -> ${post.status} for a slot the site offered (${availability}?date=${slotDate}), so a customer cannot book`),
    };
  }
  const cleanup = is2xx(post.status) ? `; ${await cleanUpBooking(fetchImpl, base, booking, post.body, slot)}` : "";
  return {
    name,
    pass: true,
    smoke: true,
    evidence: trunc(`GET ${availability}?date=${slotDate} offered a slot; POST ${booking} -> ${post.status}${cleanup}`),
  };
}

async function runSmokeCheck(name: string, check: SmokeCheck, ctx: SmokeCheckContext): Promise<Invariant> {
  try {
    return { ...(await check(ctx)), smoke: true };
  } catch {
    return { name, pass: true, smoke: true, evidence: `${name} check errored — not asserted` };
  }
}

const SIGNUP_PAGES = ["/signup", "/register", "/sign-up"] as const;

export function ownerLoginSmokeCheck(opts: {
  runId: string;
  claim: () => Promise<boolean>;
  password?: string;
  cleanup?: (email: string) => Promise<void>;
}): SmokeCheck {
  return async ({ baseUrl, fetch }) => {
    const name = "OWNER_LOGIN";
    let page = "";
    for (const r of SIGNUP_PAGES) {
      const p = await safeFetch(fetch, `${baseUrl}${r}`);
      if (p.reached && is2xx(p.status)) {
        page = r;
        break;
      }
    }
    if (!page) return { name, pass: true, evidence: "no sign-up page — owner login not asserted" };
    if (!(await opts.claim())) {
      return { name, pass: true, evidence: "owner login already checked for this build, not repeated" };
    }
    const cred = {
      email: `zavi-smoke-${opts.runId.replace(/[^A-Za-z0-9-]/g, "").toLowerCase()}@zavi.invalid`,
      password: opts.password ?? `Aa1!${randomUUID().replace(/-/g, "")}`,
      name: "Zavi smoke test",
    };
    try {
      return await ownerLoginAttempt(baseUrl, fetch, page, cred);
    } finally {
      if (opts.cleanup) await opts.cleanup(cred.email).catch(() => undefined);
    }
  };
}

async function ownerLoginAttempt(
  baseUrl: string,
  fetch: FetchLike,
  page: string,
  cred: { email: string; password: string; name: string },
): Promise<Invariant> {
  const name = "OWNER_LOGIN";
  let signup: Probe | null = null;
  let route = "";
  for (const ep of SIGNUP_ROUTE_HANDLERS) {
    let p = await safeFetch(fetch, `${baseUrl}${ep}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-zavi-smoke-test": "1" },
      body: new URLSearchParams(cred).toString(),
    });
    if (p.reached && (p.status === 400 || p.status === 415 || p.status === 422 || p.status >= 500)) {
      const pj = await safeFetch(fetch, `${baseUrl}${ep}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zavi-smoke-test": "1" },
        body: JSON.stringify(cred),
      });
      if (pj.reached && (p.status >= 500 || pj.cookie || is2xx(pj.status) || isRedirect(pj.status))) p = pj;
    }
    if (p.reached && p.status !== 404 && p.status !== 405) {
      signup = p;
      route = ep;
      break;
    }
  }
  if (!signup) return { name, pass: true, evidence: trunc(`sign-up page ${page} found but no sign-up route answered — owner login not asserted`) };
  const at = `POST ${route} -> ${signup.status}${signup.location ? ` (${signup.location})` : ""}`;
  if (signup.status >= 500 || SERVER_ERROR_LOCATION_RE.test(signup.location ?? "")) {
    return { name, pass: false, evidence: trunc(`${at}: signing up fails with a server error, so the owner cannot log in to /admin`) };
  }
  if (!signup.cookie) {
    if (isRedirect(signup.status) && !/[?&]error=/.test(signup.location ?? "")) {
      return { name, pass: false, evidence: trunc(`${at} but set no session cookie, so a new account is never logged in and the owner cannot reach /admin`) };
    }
    return { name, pass: true, evidence: trunc(`${at}, no session cookie — owner login inconclusive`) };
  }
  const admin = await safeFetch(fetch, `${baseUrl}/admin`, { headers: { cookie: signup.cookie } });
  if (!admin.reached) return { name, pass: true, evidence: trunc(`${at} +cookie; GET /admin unreachable — inconclusive`) };
  if (admin.status >= 500 || SERVER_ERROR_LOCATION_RE.test(admin.location ?? "")) {
    return { name, pass: false, evidence: trunc(`${at} +cookie; GET /admin with that session -> ${admin.status}, so the owner cannot open the admin`) };
  }
  return { name, pass: true, evidence: trunc(`${at} +cookie; GET /admin with that session -> ${admin.status}`) };
}

export async function runAcceptanceBattery(
  input: RunAcceptanceBatteryInput,
  fetchImpl: FetchLike,
): Promise<AcceptanceBatteryResult> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const slug = input.appSlug ?? "";
  const invariants: Invariant[] = [];

  const home = await safeFetch(fetchImpl, `${base}/`, { readBody: true });
  const title = titleOf(home.body);
  const titleIsSeed = (title ?? "").toLowerCase() === "your company";
  const realApp =
    home.reached &&
    is2xx(home.status) &&
    !titleIsSeed &&
    !home.body.includes("__next_error__") &&
    !looksLikeSeedPlaceholder(home.body);
  invariants.push({
    name: "REAL_APP",
    pass: realApp,
    evidence: trunc(`GET / -> ${home.status}; title=${title ?? "(none)"}`),
  });
  if (input.starterDetailsCheck === true) invariants.push(starterDetailsInvariant(home));

  let browseProbe: Probe | null = null;
  let browsePath = "";
  for (const r of BROWSE_ROUTES) {
    const p = await safeFetch(fetchImpl, `${base}${r}`);
    if (p.reached && p.status !== 404) {
      browseProbe = p;
      browsePath = r;
      break;
    }
  }
  const homeIs5xx = home.reached && home.status >= 500;
  const browseIs5xx = browseProbe?.reached === true && browseProbe.status >= 500;
  invariants.push({
    name: "NO_500_CORE",
    pass: !homeIs5xx && !browseIs5xx,
    evidence: trunc(
      `GET / -> ${home.status}; browse ${browsePath || "(none found)"} -> ${browseProbe?.status ?? "n/a"}`,
    ),
  });

  if (input.smokeGate) {
    const scan = await scanApi(fetchImpl, base, home.body);
    const date = new Date().toISOString().slice(0, 10);
    const delayMs = input.transientRetryDelayMs ?? DEFAULT_TRANSIENT_RETRY_DELAY_MS;
    const api = await probeApiRoutes(fetchImpl, base, scan, date, delayMs);
    invariants.push(api.invariant);
    const booking = await bookingSmoke(fetchImpl, base, scan, api.results, date, delayMs, input.claimBookingSmoke);
    if (booking) invariants.push(booking);
    if (input.ownerLoginCheck) {
      invariants.push(await runSmokeCheck("OWNER_LOGIN", input.ownerLoginCheck, { baseUrl: base, fetch: fetchImpl }));
    }
  }

  const cred = {
    email: `acc-probe-${Date.now()}-${Math.floor(Math.random() * 1e6)}@zavi.invalid`,
    password: `Aa1!${Math.random().toString(36).slice(2, 12)}Zz`,
    name: "Acceptance Probe",
  };
  const formBody = new URLSearchParams(cred).toString();
  const jsonBody = JSON.stringify(cred);
  let signupCookie: string | null = null;
  let signupPath = "";
  let signupStatus = 0;
  let signupServerError = "";
  for (const ep of SIGNUP_ENDPOINTS) {
    let p = await safeFetch(fetchImpl, `${base}${ep}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody,
    });
    if (p.reached && (p.status === 415 || p.status === 400 || p.status === 422 || p.status >= 500)) {
      const pj = await safeFetch(fetchImpl, `${base}${ep}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: jsonBody,
      });
      if (pj.reached && (p.status >= 500 || pj.cookie || is2xx(pj.status) || isRedirect(pj.status))) p = pj;
    }
    if (
      !signupServerError &&
      SIGNUP_ROUTE_HANDLERS.has(ep) &&
      p.reached &&
      (p.status >= 500 || (isRedirect(p.status) && SERVER_ERROR_LOCATION_RE.test(p.location ?? "")))
    ) {
      signupServerError = `POST ${ep} -> ${p.status}${p.location ? ` (${p.location})` : ""}`;
    }
    if (p.reached && p.status !== 404 && p.status !== 405) {
      signupPath = ep;
      signupStatus = p.status;
      if (p.cookie) {
        signupCookie = p.cookie;
        break;
      }
    }
  }

  let authedRoute = "";
  let skippedPublicRoute = false;
  let bouncedWithCookie = false;
  if (signupCookie) {
    for (const r of PROTECTED_ROUTES) {
      const p = await safeFetch(fetchImpl, `${base}${r}`, {
        headers: { cookie: signupCookie },
      });
      if (p.reached && is2xx(p.status)) {
        if (AMBIGUOUS_PUBLIC_ROUTES.has(r)) {
          const anon = await safeFetch(fetchImpl, `${base}${r}`);
          if (anon.reached && is2xx(anon.status)) {
            skippedPublicRoute = true;
            continue;
          }
        }
        authedRoute = r;
        break;
      }
      if (isGated(p)) bouncedWithCookie = true;
    }
  }

  if (input.smokeGate && !signupCookie && signupServerError) {
    invariants.push({
      name: "AUTH_ROUNDTRIP",
      pass: false,
      smoke: true,
      evidence: trunc(`signup fails with a server error, so nobody can create an account: ${signupServerError}`),
    });
  } else if (!signupPath) {
    invariants.push({
      name: "AUTH_ROUNDTRIP",
      pass: true,
      evidence: "no signup endpoint discovered among candidates — auth not asserted",
    });
  } else if (!signupCookie) {
    invariants.push({
      name: "AUTH_ROUNDTRIP",
      pass: true,
      evidence: trunc(`POST ${signupPath} -> ${signupStatus}, no Set-Cookie (client-side auth?) — inconclusive`),
    });
  } else if (!authedRoute && skippedPublicRoute && !bouncedWithCookie) {
    invariants.push({
      name: "AUTH_ROUNDTRIP",
      pass: true,
      evidence: trunc(`POST ${signupPath} -> ${signupStatus} +cookie; only public routes answered 200 — inconclusive`),
    });
  } else if (authedRoute) {
    invariants.push({
      name: "AUTH_ROUNDTRIP",
      pass: true,
      evidence: trunc(`POST ${signupPath} -> ${signupStatus} +cookie; authed GET ${authedRoute} -> 200`),
    });
  } else {
    invariants.push({
      name: "AUTH_ROUNDTRIP",
      pass: false,
      evidence: trunc(
        `POST ${signupPath} -> ${signupStatus} set a session cookie, but every protected route still bounced WITH the cookie (uid-type / session bug — login loops)`,
      ),
    });
  }

  let gatedRoute = "";
  for (const r of PROTECTED_ROUTES) {
    const p = await safeFetch(fetchImpl, `${base}${r}`);
    if (isGated(p)) {
      gatedRoute = r;
      break;
    }
  }
  const targetRoute = authedRoute || gatedRoute;

  if (!targetRoute) {
    invariants.push({
      name: "PROTECTED_GATING",
      pass: true,
      evidence: "no protected route discovered among candidates — gating not asserted",
    });
  } else {
    const unauth = await safeFetch(fetchImpl, `${base}${targetRoute}`);
    const gated = isGated(unauth);
    const openProtected = authedRoute && unauth.reached && is2xx(unauth.status);
    invariants.push({
      name: "PROTECTED_GATING",
      pass: gated || !openProtected,
      evidence: trunc(
        `unauth GET ${targetRoute} -> ${unauth.status}${unauth.location ? ` (Location ${unauth.location})` : ""}; ${gated ? "gated" : openProtected ? "OPEN protected area" : "no gate but route not proven-protected"}`,
      ),
    });
  }

  if (!targetRoute) {
    invariants.push({
      name: "NO_FORGED_SESSION",
      pass: true,
      evidence: "no protected route discovered — forgery not asserted",
    });
  } else {
    const names = (() => {
      const fromSignup = cookieName(signupCookie);
      return fromSignup ? [fromSignup] : [...SESSION_COOKIE_NAMES];
    })();
    const forged = forgedCookieValues(slug);
    let accepted: { name: string } | null = null;
    let probes = 0;
    const MAX_FORGE_PROBES = 24;
    outer: for (const name of names) {
      for (const value of forged) {
        if (probes >= MAX_FORGE_PROBES) break outer;
        probes++;
        const p = await safeFetch(fetchImpl, `${base}${targetRoute}`, {
          headers: { cookie: `${name}=${value}` },
        });
        if (p.reached && is2xx(p.status)) {
          accepted = { name };
          break outer;
        }
      }
    }
    invariants.push({
      name: "NO_FORGED_SESSION",
      pass: accepted === null,
      evidence:
        accepted === null
          ? trunc(`forged ${probes} default-secret/unsigned cookies on ${targetRoute} — all rejected`)
          : trunc(`a forged default-secret/unsigned cookie ("${accepted.name}") was ACCEPTED on ${targetRoute} (status 200) — account-takeover-by-default`),
    });
  }

  const firstFailure = invariants.find((i) => !i.pass)?.name ?? "";
  return { pass: firstFailure === "", invariants, firstFailure };
}
