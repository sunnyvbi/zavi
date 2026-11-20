import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { createSitePageViewHandler, parsePageView, PV_SIG_HEADER, PV_TS_HEADER, signPageView, type SitePageViewDeps } from "../site-pageview";

const SECRET = "wake-secret";
const NOW = Date.parse("2026-10-07T12:00:00Z");
const TS = String(Math.floor(NOW / 1000));
const VIEW = {
  hostname: "hale-ortiz-9f8e7d6c.zaviagent.com",
  path: "/practice-areas",
  referrer_host: "www.google.com",
  source: null,
  visitor: "0123456789abcdef0123456789abcdef",
  device: "desktop",
  country: "US",
};

function call(body: string, headers: Record<string, string>, over: Partial<SitePageViewDeps> = {}) {
  const insert = vi.fn(async () => {});
  const log = vi.fn();
  const deps: SitePageViewDeps = {
    secret: () => SECRET,
    site: async (h) => (h === VIEW.hostname ? { tenant_id: "t1", site_id: "s1" } : null),
    insert,
    now: () => NOW,
    log,
    ...over,
  };
  const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; }, end() { return this; } };
  const req = { body: Buffer.from(body), headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) } as unknown as Request;
  return { insert, log, run: () => createSitePageViewHandler(deps)(req, res as unknown as Response).then(() => res) };
}

const signed = (body: string, ts = TS) => ({ [PV_TS_HEADER]: ts, [PV_SIG_HEADER]: signPageView(SECRET, ts, body) });

describe("POST /api/public/sites/pageview", () => {
  it("stores a signed view for the live site's own tenant, with no hostname, IP or user agent", async () => {
    const body = JSON.stringify(VIEW);
    const c = call(body, signed(body));
    expect((await c.run()).statusCode).toBe(204);
    expect(c.insert).toHaveBeenCalledWith({
      tenant_id: "t1",
      site_id: "s1",
      path: "/practice-areas",
      referrer_host: "www.google.com",
      source: null,
      visitor: VIEW.visitor,
      device: "desktop",
      country: "US",
    });
  });

  it("refuses a bad or stale signature, and is closed without a secret", async () => {
    const body = JSON.stringify(VIEW);
    expect((await call(body, { [PV_TS_HEADER]: TS, [PV_SIG_HEADER]: "0".repeat(64) }).run()).statusCode).toBe(401);
    const old = String(Math.floor(NOW / 1000) - 600);
    expect((await call(body, signed(body, old)).run()).statusCode).toBe(401);
    expect((await call(body, signed(body), { secret: () => undefined }).run()).statusCode).toBe(503);
    const tampered = body.replace("/practice-areas", "/other");
    expect((await call(tampered, signed(body)).run()).statusCode).toBe(401);
  });

  it("refuses anything out of shape, and an unknown or not-live site", async () => {
    for (const bad of [{ ...VIEW, visitor: "203.0.113.7" }, { ...VIEW, path: "/x?email=a@b.c" }, { ...VIEW, device: "phone" }, { ...VIEW, extra_ip: "1.2.3.4", path: "no-slash" }]) {
      const body = JSON.stringify(bad);
      expect((await call(body, signed(body)).run()).statusCode).toBe(400);
    }
    const body = JSON.stringify({ ...VIEW, hostname: "nobody.zaviagent.com" });
    const c = call(body, signed(body));
    expect((await c.run()).statusCode).toBe(404);
    expect(c.insert).not.toHaveBeenCalled();
  });

  it("never logs the body when a write fails", async () => {
    const body = JSON.stringify(VIEW);
    const c = call(body, signed(body), { insert: async () => { throw new Error("db down"); } });
    expect((await c.run()).statusCode).toBe(500);
    expect(JSON.stringify(c.log.mock.calls)).not.toContain(VIEW.visitor);
    expect(JSON.stringify(c.log.mock.calls)).not.toContain("practice-areas");
  });

  it("parsePageView drops unknown fields", () => {
    expect(parsePageView({ ...VIEW, ip: "203.0.113.7" })).not.toHaveProperty("ip");
  });
});
