
import type { NextFunction, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { requireAuth } from "@/services/auth/middleware";

const COOKIE = "zavi_mobile_return";
const COOKIE_TTL_SECONDS = 15 * 60;
const HANDOFF_TTL_SECONDS = 5 * 60;
export const APP_RETURN_BASE = "zavi://connectors/done";
export const APP_FINISH_BASE = "zavi://connectors/finish";

function secret(): string {
  const s = (process.env.MOBILE_HANDOFF_SECRET ?? "").trim();
  return s.length >= 32 ? s : "";
}

const SIGN_IN_PAGES: ReadonlyArray<{ host: RegExp; path: RegExp; ownRedirect: boolean }> = [
  { host: /^accounts\.google\.com$/, path: /^\/o\/oauth2\//, ownRedirect: true },
  { host: /^slack\.com$/, path: /^\/oauth\/v2\/authorize$/, ownRedirect: true },
  { host: /^www\.facebook\.com$/, path: /^\/v\d+(\.\d+)?\/dialog\/oauth$/, ownRedirect: true },
  { host: /^www\.instagram\.com$/, path: /^\/oauth\/authorize\/?$/, ownRedirect: true },
  { host: /^www\.linkedin\.com$/, path: /^\/oauth\/v2\/authorization$/, ownRedirect: true },
  { host: /^x\.com$/, path: /^\/i\/oauth2\/authorize$/, ownRedirect: true },
  { host: /^business-api\.tiktok\.com$/, path: /^\/portal\/auth$/, ownRedirect: true },
  { host: /^www\.tiktok\.com$/, path: /^\/v2\/auth\/authorize\/?$/, ownRedirect: true },
  { host: /^www\.reddit\.com$/, path: /^\/api\/v1\/authorize(\.compact)?$/, ownRedirect: true },
  { host: /^login\.microsoftonline\.com$/, path: /^\/[a-z0-9.-]+\/oauth2\/(v2\.0\/)?authorize$/, ownRedirect: true },
  { host: /^auth\.atlassian\.com$/, path: /^\/authorize$/, ownRedirect: true },
  { host: /^linear\.app$/, path: /^\/oauth\/authorize$/, ownRedirect: true },
  { host: /^app\.intercom\.com$/, path: /^\/oauth$/, ownRedirect: true },
  { host: /^www\.pinterest\.com$/, path: /^\/oauth\/?$/, ownRedirect: true },
  { host: /^accounts\.snapchat\.com$/, path: /^\/login\/oauth2\/authorize$/, ownRedirect: true },
  { host: /^accounts\.spotify\.com$/, path: /^\/authorize$/, ownRedirect: true },
  { host: /^mcp\.higgsfield\.ai$/, path: /^\//, ownRedirect: true },
  { host: /^github\.com$/, path: /^\/apps\/(zavi-engineer|praxis-cto-engineer)\/installations\/new$/, ownRedirect: false },
];

export function isSignInUrl(raw: string): boolean {
  const backendOrigin = process.env.BACKEND_PUBLIC_URL;
  if (!backendOrigin) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    const page = SIGN_IN_PAGES.find((p) => p.host.test(host) && p.path.test(u.pathname));
    if (!page) return false;
    if (!page.ownRedirect) return true;
    const backs = u.searchParams.getAll("redirect_uri");
    if (backs.length !== 1) return false;
    const back = new URL(backs[0]);
    if (back.origin !== new URL(backendOrigin).origin) return false;
    const PREFIX = "/api/connectors";
    return back.pathname.startsWith(`${PREFIX}/`) && providerOfPath(back.pathname.slice(PREFIX.length)) !== null;
  } catch {
    return false;
  }
}

function webOrigin(): string {
  return (process.env.WEB_ORIGIN || "http://localhost:3000").split(",")[0].trim();
}

function backendBase(req: Request): string {
  const base = process.env.BACKEND_PUBLIC_URL;
  return (base ? base : `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

function sign(url: string, exp: number): string {
  return createHmac("sha256", secret()).update(`mobile-handoff:${exp}:${url}`).digest("base64url");
}

export function signHandoff(url: string, now = Date.now()): { exp: number; sig: string } {
  const exp = Math.floor(now / 1000) + HANDOFF_TTL_SECONDS;
  return { exp, sig: sign(url, exp) };
}

export function verifyHandoff(url: string, exp: number, sig: string, now = Date.now()): boolean {
  if (!secret() || !Number.isFinite(exp) || exp < Math.floor(now / 1000)) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(url, exp));
  return a.length === b.length && timingSafeEqual(a, b);
}

function isHttpsUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 4096) return false;
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

export async function mobileHandoff(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const url = (req.body as { url?: unknown } | undefined)?.url;
  if (!isHttpsUrl(url) || !isSignInUrl(url)) {
    res.status(400).json({ error: { code: "bad_url", message: "url must be a connector sign-in URL." } });
    return;
  }
  if (!secret()) {
    res.status(503).json({ error: { code: "handoff_unavailable", message: "Sign-in handoff is not configured." } });
    return;
  }
  const { exp, sig } = signHandoff(url);
  const q = new URLSearchParams({ u: url, exp: String(exp), sig });
  res.json({ open_url: `${backendBase(req)}/api/connectors/mobile/open?${q.toString()}` });
}

export function mobileOpen(req: Request, res: Response): void {
  const url = String(req.query.u ?? "");
  const exp = Number(req.query.exp);
  const sig = String(req.query.sig ?? "");
  if (!isHttpsUrl(url) || !isSignInUrl(url) || !verifyHandoff(url, exp, sig)) {
    res.status(400).type("text/plain").send("This sign-in link has expired. Go back to Zavi and tap Connect again.");
    return;
  }
  res.cookie(COOKIE, "1", {
    maxAge: COOKIE_TTL_SECONDS * 1000,
    httpOnly: true,
    secure: req.secure || process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/connectors",
  });
  res.redirect(302, url);
}

function hasReturnCookie(req: Request): boolean {
  const raw = req.headers.cookie ?? "";
  return raw.split(";").some((c) => c.trim() === `${COOKIE}=1`);
}

export function toAppReturn(target: string, origin = webOrigin()): string | null {
  const finish = `${origin.replace(/\/$/, "")}/connectors/finish#`;
  if (target.startsWith(finish)) return `${APP_FINISH_BASE}?${target.slice(finish.length)}`;
  const prefix = `${origin.replace(/\/$/, "")}/workspace?`;
  if (!target.startsWith(prefix)) return null;
  return `${APP_RETURN_BASE}?${target.slice(prefix.length)}`;
}

function rewriteHtml(html: string, origin = webOrigin()): string {
  const prefix = `${origin.replace(/\/$/, "")}/workspace?`;
  if (!html.includes(prefix)) return html;
  const out = html.split(prefix).join(`${APP_RETURN_BASE}?`);
  const button = `<p><a href="${APP_RETURN_BASE}" style="display:inline-block;background:#0f172a;color:#fff;border-radius:8px;padding:10px 16px;text-decoration:none">Return to Zavi</a></p>`;
  return out.includes("</body>") ? out.replace("</body>", `${button}</body>`) : out + button;
}

export function providerOfPath(path: string): string | null {
  const m = /^\/(?:(composio|pipedream)\/([a-z0-9_]+)\/return|([a-z0-9_-]+)\/(?:callback|return))\/?$/i.exec(path);
  if (!m) return null;
  return (m[1] ? `${m[1]}_${m[2]}` : m[3]).replace(/-/g, "_").toLowerCase();
}

export function errorCodeOf(body: unknown, status: number): string {
  if (typeof body === "string") {
    try {
      const j = JSON.parse(body) as { error?: { code?: unknown } | string; code?: unknown };
      const code = typeof j.error === "object" ? j.error?.code : (j.code ?? j.error);
      if (typeof code === "string" && /^[a-z0-9_]{1,64}$/i.test(code)) return code;
    } catch {
      const h1 = /<h1[^>]*>([^<]{1,80})<\/h1>/i.exec(body)?.[1];
      if (h1) return h1.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    }
  }
  return status === 403 ? "invalid_state" : status === 400 ? "missing_params" : "failed";
}

export function appErrorReturn(provider: string, code: string): string {
  const q = new URLSearchParams({ tab: "settings", connect_error: code, provider });
  return `${APP_RETURN_BASE}?${q.toString()}`;
}

export function mobileReturnMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!hasReturnCookie(req) || req.path.startsWith("/mobile/")) {
    next();
    return;
  }
  const clear = () => res.clearCookie(COOKIE, { path: "/api/connectors" });
  const provider = req.method === "GET" ? providerOfPath(req.path) : null;

  const redirect = res.redirect.bind(res) as (...a: unknown[]) => void;
  (res as unknown as { redirect: (...a: unknown[]) => void }).redirect = (...args: unknown[]) => {
    const urlIdx = typeof args[0] === "number" ? 1 : 0;
    const target = args[urlIdx];
    const app = typeof target === "string" ? toAppReturn(target) : null;
    if (app) {
      clear();
      args[urlIdx] = app;
    }
    redirect(...args);
  };

  const send = res.send.bind(res);
  res.send = ((body?: unknown) => {
    if (provider && res.statusCode >= 400 && !res.headersSent) {
      const code = errorCodeOf(typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : "", res.statusCode);
      clear();
      res.status(302);
      res.removeHeader("Content-Type");
      res.setHeader("Location", appErrorReturn(provider, code));
      return send("");
    }
    const type = String(res.get("Content-Type") ?? "");
    if (typeof body === "string" && (type.includes("html") || /^\s*<!doctype html/i.test(body))) {
      const out = rewriteHtml(body);
      if (out !== body) clear();
      return send(out);
    }
    return send(body as never);
  }) as Response["send"];

  next();
}
