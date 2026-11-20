import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const auth = { tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u1", access_token: "tok" };
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn(async () => auth) }));

import { makeGetSitePreviewSnapshot, type PreviewSnapshotRouteDeps } from "../site-preview-snapshot";
import type { SiteRow } from "@/services/sites/contract";

const T = auth.tenant_id;
const S = "aaaaaaaa-0000-4000-8000-00000000000a";
const desktopPath = `${T}/${S}/site-preview-desktop-aaaaaaaaaaaa.jpg`;
const mobilePath = `${T}/${S}/site-preview-mobile-bbbbbbbbbbbb.jpg`;

function res() {
  const r = { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  const out = {
    status: vi.fn((c: number): unknown => ((r.statusCode = c), out)),
    json: vi.fn((b: unknown): unknown => ((r.body = b), out)),
    setHeader: vi.fn((k: string, v: string): unknown => ((r.headers[k] = v), out)),
  };
  return { r, out: out as unknown as Response };
}

const site = (over: Partial<SiteRow> = {}) => ({ id: S, tenant_id: T, status: "live", ...over }) as SiteRow;

function call(deps: PreviewSnapshotRouteDeps, appId: unknown = `site:${S}`) {
  const { r, out } = res();
  return makeGetSitePreviewSnapshot(() => deps)({ query: { app_id: appId } } as unknown as Request, out).then(() => r);
}

let deps: PreviewSnapshotRouteDeps;
beforeEach(() => {
  deps = {
    loadSite: vi.fn(async () => site()),
    fresh: vi.fn(async () => [
      { device: "desktop" as const, path: desktopPath, taken_at: "2026-10-13T12:00:00Z", width: 1280, height: 800 },
      { device: "mobile" as const, path: mobilePath, taken_at: "2026-10-13T12:00:00Z", width: 390, height: 844 },
    ]),
    sign: vi.fn(async (_t: string, paths: string[]) => paths.map((p) => `https://signed/${p}`)),
  };
});

describe("GET /api/website/preview-snapshot", () => {
  it("returns signed fresh snapshots per device, never cached by the browser", async () => {
    const r = await call(deps);
    expect(r.headers["Cache-Control"]).toBe("private, no-store");
    expect(r.body).toEqual({
      snapshots: {
        desktop: { url: `https://signed/${desktopPath}`, width: 1280, height: 800, taken_at: "2026-10-13T12:00:00Z" },
        mobile: { url: `https://signed/${mobilePath}`, width: 390, height: 844, taken_at: "2026-10-13T12:00:00Z" },
      },
    });
    expect(deps.fresh).toHaveBeenCalledWith(T, S);
    expect(deps.sign).toHaveBeenCalledWith(T, [desktopPath, mobilePath]);
  });

  it("answers 404 for a site of another tenant and signs nothing", async () => {
    deps.loadSite = vi.fn(async () => site({ tenant_id: "22222222-2222-4222-8222-222222222222" }));
    const r = await call(deps);
    expect(r.statusCode).toBe(404);
    expect(deps.fresh).not.toHaveBeenCalled();
    expect(deps.sign).not.toHaveBeenCalled();
  });

  it("answers 404 for a deleted site", async () => {
    deps.loadSite = vi.fn(async () => site({ status: "deleted" as SiteRow["status"] }));
    expect((await call(deps)).statusCode).toBe(404);
  });

  it("refuses an app id that is not a site", async () => {
    expect((await call(deps, "legacy-app")).statusCode).toBe(400);
    expect(deps.loadSite).not.toHaveBeenCalled();
  });

  it("leaves out a device whose url could not be signed", async () => {
    deps.sign = vi.fn(async () => [null, "https://signed/m"]);
    const r = await call(deps);
    expect(Object.keys((r.body as { snapshots: object }).snapshots)).toEqual(["mobile"]);
  });

  it("falls back to no snapshot (today's loader) when the read fails", async () => {
    deps.fresh = vi.fn(async () => Promise.reject(new Error("db down")));
    const r = await call(deps);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ snapshots: {} });
  });
});
