export interface R2ObjectBodyLike {
  body: ReadableStream | null;
  size: number;
  httpEtag?: string;
  httpMetadata?: { contentType?: string };
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
}

export interface KVNamespaceLike {
  get(key: string, type: "text"): Promise<string | null>;
  put?(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  SITES: R2BucketLike;
  HOSTS: KVNamespaceLike;
  PREVIEW_HMAC_SECRET?: string;
  WAKE_HMAC_SECRET?: string;
  ZAVI_API?: string;
  PREVIEW_DOMAIN?: string;
}

export interface PreviewRecord {
  v: 1;
  hostname: string;
  test_site_id: string;
  deploy_id: string;
  exp: number;
}

export interface HostRecord {
  deploy_id: string;
  sha: string;
  tenant_id: string;
  published_at: string;
  spa?: boolean;
  noindex?: boolean;
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wasm: "application/wasm",
  pdf: "application/pdf",
  rsc: "text/x-component",
};

const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";
const REVALIDATE = "public, max-age=0, must-revalidate";
const DEPLOY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PREVIEW_CACHE = "private, no-store";

export const PREVIEW_PREFIX = "/__zavi_preview/";
export const PREVIEW_COOKIE = "__zavi_preview";
export const PREVIEW_FRAME_COOKIE = "__zavi_preview_frame";
export const PREVIEW_EMBED_PARAM = "zavi_embed";
export const PREVIEW_END_PATH = "/__zavi_preview_end";

const CLEAR_FRAME_COOKIE = `${PREVIEW_FRAME_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned`;

function safeNextPath(raw: string | null): string {
  const next = raw ?? "/";
  return next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/";
}

function previewEnd(url: URL): Response {
  const headers = new Headers({ location: safeNextPath(url.searchParams.get("next")), "cache-control": "no-store" });
  headers.append("set-cookie", `${PREVIEW_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  headers.append("set-cookie", `${PREVIEW_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned`);
  headers.append("set-cookie", CLEAR_FRAME_COOKIE);
  return new Response(null, { status: 302, headers });
}

function isTopLevelDocument(request: Request): boolean {
  return (request.headers.get("sec-fetch-dest") ?? "").toLowerCase() === "document";
}
export const PREVIEW_MAX_TTL_S = 15 * 60;
const CLOCK_SKEW_S = 60;
export const LASTSEEN_INTERVAL_MS = 60 * 60 * 1000;
export const WAKE_PATH = "/api/public/sites/wake";

export const PAGEVIEW_PATH = "/__zavi/e";
export const PAGEVIEW_API_PATH = "/api/public/sites/pageview";
export const PAGEVIEW_SALT_TTL_S = 3 * 24 * 60 * 60;
export const PAGEVIEW_DEDUPE_MS = 30 * 60 * 1000;
export const PAGEVIEW_MAX_PER_CLIENT_HOUR = 120;
const PAGEVIEW_MAX_BODY = 2048;
const PAGEVIEW_PRIVATE = /^\/(?:admin|account|login|auth|__zavi)(?:[/?#]|$)/;
const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|embedly|curl|wget|python|httpclient|okhttp|axios|node-fetch|go-http|java\//i;
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const PAGEVIEW_SCRIPT =
  `<script data-zavi="pv">(function(){try{if(window.__zaviPv||window.top!==window)return;window.__zaviPv=1;` +
  `var first=1,last="";function send(){var p=location.pathname;if(p===last)return;last=p;var d={p:p};` +
  `if(first){first=0;try{d.r=document.referrer?new URL(document.referrer).hostname:""}catch(e){d.r=""}` +
  `var m=/[?&]utm_source=([^&#]*)/.exec(location.search);` +
  `if(m){try{d.s=decodeURIComponent(m[1].replace(/\\+/g," ")).slice(0,100)}catch(e){}}}` +
  `fetch("${PAGEVIEW_PATH}",{method:"POST",body:JSON.stringify(d),keepalive:true,credentials:"omit",referrerPolicy:"no-referrer"}).catch(function(){})}` +
  `var h=history;["pushState","replaceState"].forEach(function(k){var o=h[k];h[k]=function(){var x=o.apply(this,arguments);setTimeout(send,0);return x}});` +
  `addEventListener("popstate",function(){setTimeout(send,0)});send()}catch(e){}})()</script>`;

export function withPageViewScript(html: string): string {
  if (html.includes('data-zavi="pv"')) return html;
  const at = html.search(/<\/head>/i);
  const end = at >= 0 ? at : html.search(/<\/body>/i);
  return end < 0 ? html : `${html.slice(0, end)}${PAGEVIEW_SCRIPT}${html.slice(end)}`;
}

export function pageViewPath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) return null;
  let p = raw.split(/[?#]/)[0].replace(/\s+/g, "");
  if (p.length > 1) p = p.replace(/\/+$/, "") || "/";
  p = p.slice(0, 200);
  if (PAGEVIEW_PRIVATE.test(p)) return null;
  return p;
}

export function referrerHost(raw: unknown, hostname: string): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 253) return null;
  const h = normalizeHost(raw.trim());
  return h === hostname || !HOSTNAME_RE.test(h) ? null : h;
}

export function deviceClass(ua: string): "mobile" | "tablet" | "desktop" {
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android/i.test(ua)) return "mobile";
  return "desktop";
}

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
const saltCache = new Map<string, string>();
const madeSalt = new Map<string, string>();

async function saltFor(env: Env, day: string, create: boolean): Promise<string | null> {
  const cached = saltCache.get(day);
  if (cached) return cached;
  const key = `pvsalt:${day}`;
  const stored = await env.HOSTS.get(key, "text");
  if (stored) {
    if (saltCache.size > 4) saltCache.clear();
    saltCache.set(day, stored);
    return stored;
  }
  const pending = madeSalt.get(day);
  if (pending) return pending;
  if (!create || !env.HOSTS.put) return null;
  const made = randomHex();
  if (madeSalt.size > 4) madeSalt.clear();
  madeSalt.set(day, made);
  await env.HOSTS.put(key, made, { expirationTtl: PAGEVIEW_SALT_TTL_S });
  return made;
}

export async function dailySalt(env: Env, nowMs: number): Promise<string | null> {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const tomorrow = new Date(nowMs + 86_400_000).toISOString().slice(0, 10);
  const salt = await saltFor(env, today, true);
  if (!saltCache.has(tomorrow) && !madeSalt.has(tomorrow)) await saltFor(env, tomorrow, true);
  return salt;
}

export function resetPageViewState(): void {
  saltCache.clear();
  madeSalt.clear();
  recent.clear();
  perClient.clear();
}

const recent = new Map<string, number>();
const perClient = new Map<string, { hour: number; n: number }>();

export function admitPageView(visitor: string, client: string, path: string, nowMs: number): boolean {
  if (recent.size > 50_000) recent.clear();
  if (perClient.size > 50_000) perClient.clear();
  const hour = Math.floor(nowMs / 3_600_000);
  const c = perClient.get(client);
  const n = c && c.hour === hour ? c.n : 0;
  if (n >= PAGEVIEW_MAX_PER_CLIENT_HOUR) return false;
  const key = `${visitor}|${path}`;
  const seen = recent.get(key);
  if (seen !== undefined && nowMs - seen < PAGEVIEW_DEDUPE_MS) return false;
  recent.set(key, nowMs);
  perClient.set(client, { hour, n: n + 1 });
  return true;
}

export async function visitorId(salt: string, hostname: string, ip: string, ua: string): Promise<string> {
  return (await sha256Hex(`${salt}|${hostname}|${ip}|${ua}`)).slice(0, 32);
}

async function handlePageView(request: Request, env: Env, ctx: ExecutionContextLike | undefined, hostname: string, nowMs: number): Promise<Response> {
  const done = new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  const ua = request.headers.get("user-agent") ?? "";
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  if (!ua || !ip || BOT_UA.test(ua) || !env.WAKE_HMAC_SECRET || !env.ZAVI_API) return done;
  const record = await readHostRecord(env, hostname);
  if (!record?.spa || (await env.HOSTS.get(`paused:${hostname}`, "text"))) return done;
  let body: { p?: unknown; r?: unknown; s?: unknown };
  try {
    const text = await request.text();
    if (text.length > PAGEVIEW_MAX_BODY) return done;
    body = JSON.parse(text) as typeof body;
  } catch {
    return done;
  }
  const path = pageViewPath(body?.p);
  if (!path) return done;
  const source = typeof body.s === "string" ? body.s.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 100) || null : null;
  const country = String((request as Request & { cf?: { country?: unknown } }).cf?.country ?? "");
  background(
    ctx,
    (async () => {
      const salt = await dailySalt(env, nowMs);
      if (!salt) return;
      const visitor = await visitorId(salt, hostname, ip, ua);
      const client = (await sha256Hex(`${salt}|ip|${ip}`)).slice(0, 32);
      if (!admitPageView(visitor, client, `${hostname}${path}`, nowMs)) return;
      const event = JSON.stringify({
        hostname,
        path,
        referrer_host: referrerHost(body.r, hostname),
        source,
        visitor,
        device: deviceClass(ua),
        country: /^[A-Z]{2}$/.test(country) ? country : null,
      });
      const ts = String(Math.floor(nowMs / 1000));
      const sig = await hmacHex(env.WAKE_HMAC_SECRET!, `pageview.${ts}.${event}`);
      await fetch(`${env.ZAVI_API!.replace(/\/+$/, "")}${PAGEVIEW_API_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zavi-pv-ts": ts, "x-zavi-pv-sig": sig },
        body: event,
      });
    })(),
  );
  return done;
}

export function contentTypeFor(key: string): string {
  const base = key.slice(key.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return CONTENT_TYPES[base.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

export function cacheControlFor(key: string): string {
  if (key.startsWith("_next/static/")) return IMMUTABLE;
  if (contentTypeFor(key).startsWith("text/html")) return NO_CACHE;
  return REVALIDATE;
}

export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

export function candidateKeys(pathname: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/").filter((s) => s !== "");
  if (segments.some((s) => s === "." || s === "..")) return null;
  const rel = segments.join("/");
  if (rel === "") return ["index.html"];
  if (decoded.endsWith("/")) return [`${rel}/index.html`, `${rel}.html`];
  return [rel, `${rel}.html`, `${rel}/index.html`];
}

function textResponse(status: number, text: string, method: string, extra: Record<string, string> = {}): Response {
  return new Response(method === "HEAD" ? null : text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

function objectResponse(
  obj: R2ObjectBodyLike,
  key: string,
  status: number,
  method: string,
  deployId: string,
  preview = false,
): Response {
  const headers: Record<string, string> = {
    "content-type": contentTypeFor(key),
    "cache-control": preview ? PREVIEW_CACHE : cacheControlFor(key),
    "content-length": String(obj.size),
    "x-content-type-options": "nosniff",
    "x-zavi-deploy-id": deployId,
  };
  if (obj.httpEtag) headers.etag = obj.httpEtag;
  if (preview) headers["x-zavi-preview"] = "1";
  return new Response(method === "HEAD" ? null : obj.body, { status, headers });
}

const PREVIEW_LABEL = /^[a-z2-7]{26}$/;
const PREVIEW_DOMAIN_RE = /^(?=.{4,200}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const STRICT_DEPLOY_ID = /^d[0-9a-z]{9}-[0-9a-f]{8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIVE_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function previewDomainOf(env: Pick<Env, "PREVIEW_DOMAIN">): string | null {
  const d = String(env.PREVIEW_DOMAIN ?? "").trim().toLowerCase().replace(/\.$/, "");
  return PREVIEW_DOMAIN_RE.test(d) ? d : null;
}

export function hostKind(hostname: string, domain: string | null): "preview" | "reserved" | "site" {
  if (!domain) return "site";
  if (hostname === domain) return "reserved";
  if (!hostname.endsWith(`.${domain}`)) return "site";
  return PREVIEW_LABEL.test(hostname.slice(0, -(domain.length + 1))) ? "preview" : "reserved";
}

export async function readPreviewRecord(env: Env, hostname: string, domain: string, nowMs: number): Promise<PreviewRecord | null> {
  const raw = await env.HOSTS.get(`preview:${hostname}`, "text");
  if (!raw) return null;
  let rec: PreviewRecord;
  try {
    rec = JSON.parse(raw) as PreviewRecord;
  } catch {
    return null;
  }
  if (
    !rec || rec.v !== 1 ||
    typeof rec.hostname !== "string" || !LIVE_HOST.test(rec.hostname) || hostKind(rec.hostname, domain) !== "site" ||
    typeof rec.test_site_id !== "string" || !UUID.test(rec.test_site_id) ||
    typeof rec.deploy_id !== "string" || !STRICT_DEPLOY_ID.test(rec.deploy_id) ||
    typeof rec.exp !== "number" || !Number.isSafeInteger(rec.exp) || rec.exp * 1000 <= nowMs
  ) {
    return null;
  }
  return rec;
}

async function readHostRecord(env: Env, hostname: string): Promise<HostRecord | null> {
  const raw = await env.HOSTS.get(`host:${hostname}`, "text");
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as HostRecord;
    if (typeof rec?.deploy_id !== "string" || !DEPLOY_ID.test(rec.deploy_id)) return null;
    return rec;
  } catch {
    return null;
  }
}

function acceptsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").toLowerCase().includes("text/html");
}

export function isHtmlNavigation(request: Request, pathname: string): boolean {
  if (!acceptsHtml(request)) return false;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !last.includes(".");
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPreviewToken(
  secret: string | undefined,
  hostname: string,
  deployId: string,
  token: string,
  nowMs: number,
): Promise<number | null> {
  if (!secret || !DEPLOY_ID.test(deployId)) return null;
  const m = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return null;
  const exp = Number(m[1]);
  const nowS = Math.floor(nowMs / 1000);
  if (exp <= nowS || exp > nowS + PREVIEW_MAX_TTL_S + CLOCK_SKEW_S) return null;
  const expected = await hmacHex(secret, `preview.${hostname}.${deployId}.${exp}`);
  return timingSafeEqual(expected, m[2]) ? exp - nowS : null;
}

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

async function previewDeployFromCookie(
  request: Request,
  env: Env,
  hostname: string,
  nowMs: number,
  name: string = PREVIEW_COOKIE,
): Promise<string | null> {
  const value = readCookie(request, name);
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const deployId = value.slice(0, dot);
  const ttl = await verifyPreviewToken(env.PREVIEW_HMAC_SECRET, hostname, deployId, value.slice(dot + 1), nowMs);
  return ttl === null ? null : deployId;
}

async function previewEntry(request: Request, env: Env, url: URL, hostname: string, method: string, nowMs: number): Promise<Response> {
  const rest = url.pathname.slice(PREVIEW_PREFIX.length);
  const slash = rest.indexOf("/");
  const deployId = slash < 0 ? rest : rest.slice(0, slash);
  const token = url.searchParams.get("t") ?? "";
  const ttl = await verifyPreviewToken(env.PREVIEW_HMAC_SECRET, hostname, deployId, token, nowMs);
  if (ttl === null) return textResponse(403, "This preview link is invalid or has expired", method);
  const params = new URLSearchParams(url.search);
  params.delete("t");
  const embed = params.get(PREVIEW_EMBED_PARAM) === "1";
  params.delete(PREVIEW_EMBED_PARAM);
  const qs = params.toString();
  const path = slash < 0 ? "/" : rest.slice(slash) || "/";
  return new Response(null, {
    status: 302,
    headers: {
      location: `${path}${qs ? `?${qs}` : ""}`,
      "cache-control": "no-store",
      "set-cookie": embed
        ? `${PREVIEW_FRAME_COOKIE}=${deployId}.${token}; Path=/; Max-Age=${ttl}; HttpOnly; Secure; SameSite=None; Partitioned`
        : `${PREVIEW_COOKIE}=${deployId}.${token}; Path=/; Max-Age=${ttl}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

const WAKING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15"><title>Waking up</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#faf9f7;color:#1f1f1f}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.4rem;margin:0 0 .75rem}p{margin:0;line-height:1.5;color:#555}</style>
</head><body><main><h1>This site is waking up</h1><p>It has been resting and takes about 2 minutes to start. This page refreshes on its own.</p></main></body></html>`;

function wakingResponse(method: string, html: boolean): Response {
  if (!html) return textResponse(503, "This site is waking up", method, { "retry-after": "30" });
  return new Response(method === "HEAD" ? null : WAKING_PAGE, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "30" },
  });
}

const UNPUBLISHED_SITE_MESSAGE = "This site hasn't been published yet. Publish it from Zavi to see it here.";

const UNPUBLISHED_SITE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="15">
<title>Not published yet</title>
<style>
html,body{height:100%;margin:0}
body{background:#1c1c1c;color:#a1a1aa;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:0 16px;box-sizing:border-box;text-align:center}
main{display:flex;flex-direction:column;align-items:center;gap:28px;max-width:640px}
svg{width:88px;height:88px}
p{margin:0;font-size:17px;line-height:1.5;letter-spacing:.01em}
</style>
</head>
<body>
<main>
<svg viewBox="0 0 88 88" aria-hidden="true"><rect width="88" height="88" rx="24" fill="#a1a1aa"/><path d="M26 28h36v8L38 60h24v8H26v-8l24-24H26z" fill="#1c1c1c"/></svg>
<p>${UNPUBLISHED_SITE_MESSAGE}</p>
</main>
</body>
</html>`;

function unpublishedResponse(method: string, html: boolean): Response {
  if (!html) return textResponse(404, "This site is not published yet", method);
  return new Response(method === "HEAD" ? null : UNPUBLISHED_SITE_HTML, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
}

async function postWake(env: Env, hostname: string, nowMs: number): Promise<void> {
  if (!env.WAKE_HMAC_SECRET || !env.ZAVI_API) return;
  try {
    const ts = Math.floor(nowMs / 1000);
    const sig = await hmacHex(env.WAKE_HMAC_SECRET, `${hostname}.${ts}`);
    await fetch(`${env.ZAVI_API.replace(/\/+$/, "")}${WAKE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zavi-wake-sig": sig, "x-zavi-wake-ts": String(ts) },
      body: JSON.stringify({ hostname }),
    });
  } catch {
  }
}

async function markSeen(env: Env, hostname: string, nowMs: number): Promise<void> {
  if (!env.HOSTS.put) return;
  try {
    const key = `lastseen:${hostname}`;
    const prev = await env.HOSTS.get(key, "text");
    const prevMs = prev ? Date.parse(prev) : NaN;
    if (Number.isFinite(prevMs) && nowMs - prevMs < LASTSEEN_INTERVAL_MS) return;
    await env.HOSTS.put(key, new Date(nowMs).toISOString());
  } catch {
  }
}

function background(ctx: ExecutionContextLike | undefined, work: Promise<unknown>): void {
  const safe = work.catch(() => undefined);
  if (ctx) ctx.waitUntil(safe);
}

async function serveDeploy(
  request: Request,
  env: Env,
  url: URL,
  hostname: string,
  deployId: string,
  method: string,
  opts: { spa: boolean; preview: boolean },
): Promise<{ response: Response; html: boolean }> {
  const prefix = `sites/${hostname}/${deployId}/`;
  const keys = candidateKeys(url.pathname) ?? [];
  for (const key of keys) {
    const obj = await env.SITES.get(prefix + key);
    if (obj) {
      return {
        response: objectResponse(obj, key, 200, method, deployId, opts.preview),
        html: contentTypeFor(key).startsWith("text/html"),
      };
    }
  }
  if (opts.spa && keys.length > 0 && isHtmlNavigation(request, url.pathname)) {
    const index = await env.SITES.get(`${prefix}index.html`);
    if (index) return { response: objectResponse(index, "index.html", 200, method, deployId, opts.preview), html: true };
  }
  const notFound = await env.SITES.get(`${prefix}404.html`);
  if (notFound) return { response: objectResponse(notFound, "404.html", 404, method, deployId, opts.preview), html: false };
  return { response: textResponse(404, "Not Found", method), html: false };
}

async function handlePreviewHost(request: Request, env: Env, url: URL, hostname: string, domain: string, method: string, nowMs: number): Promise<Response> {
  const rec = await readPreviewRecord(env, hostname, domain, nowMs);
  if (!rec) return textResponse(404, "This preview does not exist or has expired", method);
  if (url.pathname.startsWith(PREVIEW_PREFIX)) {
    const rest = url.pathname.slice(PREVIEW_PREFIX.length);
    const slash = rest.indexOf("/");
    if ((slash < 0 ? rest : rest.slice(0, slash)) !== rec.deploy_id) {
      return textResponse(403, "This preview link is invalid or has expired", method);
    }
    return previewEntry(request, env, url, hostname, method, nowMs);
  }
  const cookieDeploy =
    (await previewDeployFromCookie(request, env, hostname, nowMs)) ??
    (await previewDeployFromCookie(request, env, hostname, nowMs, PREVIEW_FRAME_COOKIE));
  if (cookieDeploy !== rec.deploy_id) return textResponse(403, "Open this preview from its signed link", method);
  return (await serveDeploy(request, env, url, rec.hostname, rec.deploy_id, method, { spa: true, preview: true })).response;
}

export async function handle(
  request: Request,
  env: Env,
  ctx?: ExecutionContextLike,
  now: () => number = Date.now,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "POST" && new URL(request.url).pathname === PAGEVIEW_PATH) {
    const host = normalizeHost(new URL(request.url).hostname);
    if (hostKind(host, previewDomainOf(env)) !== "site") return textResponse(404, "Not Found", method);
    return handlePageView(request, env, ctx, host, now());
  }
  if (method !== "GET" && method !== "HEAD") {
    return textResponse(405, "Method Not Allowed", method, { allow: "GET, HEAD" });
  }
  const url = new URL(request.url);
  const hostname = normalizeHost(url.hostname);
  const nowMs = now();

  const domain = previewDomainOf(env);
  const kind = hostKind(hostname, domain);
  if (kind === "reserved") return textResponse(404, "This preview does not exist or has expired", method);
  if (kind === "preview" && domain) return handlePreviewHost(request, env, url, hostname, domain, method, nowMs);

  if (url.pathname.startsWith(PREVIEW_PREFIX)) return previewEntry(request, env, url, hostname, method, nowMs);
  if (url.pathname === PREVIEW_END_PATH) return previewEnd(url);
  const topLevel = isTopLevelDocument(request);
  const framePreview = topLevel ? null : await previewDeployFromCookie(request, env, hostname, nowMs, PREVIEW_FRAME_COOKIE);
  const previewDeploy = (await previewDeployFromCookie(request, env, hostname, nowMs)) ?? framePreview;
  if (previewDeploy) {
    return (await serveDeploy(request, env, url, hostname, previewDeploy, method, { spa: true, preview: true })).response;
  }
  const clearFrame = topLevel && readCookie(request, PREVIEW_FRAME_COOKIE) !== null;
  const live = await serveLive(request, env, ctx, url, hostname, method, nowMs);
  if (!clearFrame) return live;
  const headers = new Headers(live.headers);
  headers.append("set-cookie", CLEAR_FRAME_COOKIE);
  return new Response(live.body, { status: live.status, statusText: live.statusText, headers });
}

async function serveLive(
  request: Request,
  env: Env,
  ctx: ExecutionContextLike | undefined,
  url: URL,
  hostname: string,
  method: string,
  nowMs: number,
): Promise<Response> {
  const record = await readHostRecord(env, hostname);
  if (!record) return unpublishedResponse(method, acceptsHtml(request));
  const res = await serveRecord(request, env, ctx, url, hostname, method, nowMs, record);
  if (record.noindex !== true) return res;
  const headers = new Headers(res.headers);
  headers.set("x-robots-tag", "noindex, nofollow");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function serveRecord(
  request: Request,
  env: Env,
  ctx: ExecutionContextLike | undefined,
  url: URL,
  hostname: string,
  method: string,
  nowMs: number,
  record: HostRecord,
): Promise<Response> {
  const spa = record.spa === true;

  if (spa && (await env.HOSTS.get(`paused:${hostname}`, "text"))) {
    const html = acceptsHtml(request);
    if (html) background(ctx, postWake(env, hostname, nowMs));
    return wakingResponse(method, html);
  }

  const served = await serveDeploy(request, env, url, hostname, record.deploy_id, method, { spa, preview: false });
  if (spa && served.html && served.response.status === 200) {
    background(ctx, markSeen(env, hostname, nowMs));
    if (method === "GET") return withBeacon(served.response);
    const headers = new Headers(served.response.headers);
    headers.delete("content-length");
    headers.delete("etag");
    return new Response(null, { status: served.response.status, headers });
  }
  return served.response;
}

async function withBeacon(res: Response): Promise<Response> {
  const html = await res.text();
  const out = withPageViewScript(html);
  const headers = new Headers(res.headers);
  headers.set("content-length", String(new TextEncoder().encode(out).length));
  headers.delete("etag");
  return new Response(out, { status: res.status, statusText: res.statusText, headers });
}

export default {
  fetch(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
    return handle(request, env, ctx);
  },
};
