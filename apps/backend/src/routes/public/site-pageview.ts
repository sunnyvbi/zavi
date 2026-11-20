
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { createSitePublicResolver } from "@/services/sites/public-resolver";

export const PV_SIG_HEADER = "x-zavi-pv-sig";
export const PV_TS_HEADER = "x-zavi-pv-ts";
export const PV_MAX_SKEW_MS = 5 * 60 * 1000;
const MAX_BODY = 4096;

const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PATH_RE = /^\/[^\s?#]{0,199}$/;
const VISITOR_RE = /^[0-9a-f]{32}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const DEVICES = new Set(["mobile", "tablet", "desktop"]);

export type PageView = {
  hostname: string;
  path: string;
  referrer_host: string | null;
  source: string | null;
  visitor: string;
  device: "mobile" | "tablet" | "desktop";
  country: string | null;
};

export function signPageView(secret: string, ts: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`pageview.${ts}.${rawBody}`).digest("hex");
}

export function verifyPageView(secret: string, ts: string, sig: string, rawBody: string, nowMs: number): boolean {
  if (!/^\d{1,12}$/.test(ts) || !/^[0-9a-f]{64}$/i.test(sig)) return false;
  if (Math.abs(nowMs - Number(ts) * 1000) > PV_MAX_SKEW_MS) return false;
  const want = Buffer.from(signPageView(secret, ts, rawBody), "hex");
  const got = Buffer.from(sig.toLowerCase(), "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}

export function parsePageView(body: unknown): PageView | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const optional = (v: unknown, max: number) => (v === null || v === undefined || v === "" ? null : typeof v === "string" && v.length <= max ? v : undefined);
  const referrer = optional(b.referrer_host, 255);
  const source = optional(b.source, 100);
  const country = optional(b.country, 2);
  if (
    typeof b.hostname !== "string" || !HOST_RE.test(b.hostname) ||
    typeof b.path !== "string" || !PATH_RE.test(b.path) ||
    typeof b.visitor !== "string" || !VISITOR_RE.test(b.visitor) ||
    typeof b.device !== "string" || !DEVICES.has(b.device) ||
    referrer === undefined || (referrer !== null && !HOST_RE.test(referrer)) ||
    source === undefined || (source !== null && /[\u0000-\u001f]/.test(source)) ||
    country === undefined || (country !== null && !COUNTRY_RE.test(country))
  ) {
    return null;
  }
  return { hostname: b.hostname, path: b.path, referrer_host: referrer, source, visitor: b.visitor, device: b.device as PageView["device"], country };
}

export type SitePageViewDeps = {
  secret: () => string | undefined;
  site: (hostname: string) => Promise<{ tenant_id: string; site_id: string } | null>;
  insert: (row: { tenant_id: string; site_id: string } & Omit<PageView, "hostname">) => Promise<void>;
  now: () => number;
  log?: (msg: string) => void;
};

function header(req: Request, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v ?? "").trim();
}

export function createSitePageViewHandler(deps: SitePageViewDeps) {
  const log = deps.log ?? (() => {});
  return async function sitePageView(req: Request, res: Response): Promise<void> {
    const secret = (deps.secret() ?? "").trim();
    if (!secret) {
      res.status(503).json({ status: "unavailable" });
      return;
    }
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (!raw || raw.length > MAX_BODY || !verifyPageView(secret, header(req, PV_TS_HEADER), header(req, PV_SIG_HEADER), raw, deps.now())) {
      res.status(401).json({ status: "unauthorized" });
      return;
    }
    let view: PageView | null = null;
    try {
      view = parsePageView(JSON.parse(raw));
    } catch {
      view = null;
    }
    if (!view) {
      res.status(400).json({ status: "bad_request" });
      return;
    }
    try {
      const site = await deps.site(view.hostname);
      if (!site) {
        res.status(404).json({ status: "unknown" });
        return;
      }
      const { hostname: _h, ...fields } = view;
      await deps.insert({ tenant_id: site.tenant_id, site_id: site.site_id, ...fields });
      res.status(204).end();
    } catch (e) {
      log(`[site-pageview] store failed: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`);
      res.status(500).json({ status: "error" });
    }
  };
}

const resolver = createSitePublicResolver();
export const sitePageView = createSitePageViewHandler({
  secret: () => process.env.SITE_WAKE_HMAC_SECRET,
  async site(hostname) {
    const found = await resolver.byHostname(hostname);
    return found && found.status === "live" ? { tenant_id: found.tenant_id, site_id: found.site_id } : null;
  },
  async insert(row) {
    const { error } = await tenantClient(asTenantId(row.tenant_id)).from("site_page_views").insert({ ...row });
    if (error) throw new Error(error.message);
  },
  now: () => Date.now(),
  log: (m) => console.warn(m),
});
