
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { defaultIdleDeps, wakeSite, type WakeResult } from "@/services/sites/idle";

export const WAKE_SIG_HEADER = "x-zavi-wake-sig";
export const WAKE_TS_HEADER = "x-zavi-wake-ts";
export const WAKE_MAX_SKEW_MS = 5 * 60 * 1000;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function signWake(secret: string, hostname: string, ts: string): string {
  return createHmac("sha256", secret).update(`${hostname}.${ts}`).digest("hex");
}

export type SiteWakeDeps = {
  secret: () => string | undefined;
  wake: (hostname: string) => Promise<WakeResult>;
  now: () => number;
  log?: (msg: string) => void;
};

function header(req: Request, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v ?? "").trim();
}

export function verifyWake(secret: string, hostname: string, ts: string, sig: string, nowMs: number): boolean {
  if (!/^\d{1,16}$/.test(ts) || !/^[0-9a-f]{64}$/i.test(sig)) return false;
  const n = Number(ts);
  const tsMs = n < 1e12 ? n * 1000 : n;
  if (!Number.isFinite(tsMs) || Math.abs(nowMs - tsMs) > WAKE_MAX_SKEW_MS) return false;
  const want = Buffer.from(signWake(secret, hostname, ts), "hex");
  const got = Buffer.from(sig.toLowerCase(), "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}

export function createSiteWakeHandler(deps: SiteWakeDeps) {
  const log = deps.log ?? (() => {});
  return async function siteWake(req: Request, res: Response): Promise<void> {
    const secret = (deps.secret() ?? "").trim();
    if (!secret) {
      res.status(503).json({ status: "unavailable" });
      return;
    }
    const hostname = typeof req.body?.hostname === "string" ? req.body.hostname : "";
    const ts = header(req, WAKE_TS_HEADER);
    const sig = header(req, WAKE_SIG_HEADER);
    if (!hostname || !verifyWake(secret, hostname, ts, sig, deps.now())) {
      res.status(401).json({ status: "unauthorized" });
      return;
    }
    const host = hostname.trim().toLowerCase();
    if (!HOST_RE.test(host)) {
      res.status(400).json({ status: "bad_request" });
      return;
    }
    try {
      const r = await deps.wake(host);
      r.done?.catch(() => {});
      res.status(r.status === "unknown" ? 404 : 200).json({ status: r.status });
    } catch (e) {
      log(`[site-wake] wake failed: ${e instanceof Error ? e.message.slice(0, 200) : "error"}`);
      res.status(500).json({ status: "error" });
    }
  };
}

let _deps: ReturnType<typeof defaultIdleDeps> | null = null;
export const siteWake = createSiteWakeHandler({
  secret: () => process.env.SITE_WAKE_HMAC_SECRET,
  wake: (hostname) => wakeSite(hostname, (_deps ??= defaultIdleDeps())),
  now: () => Date.now(),
  log: (m) => console.warn(m),
});
