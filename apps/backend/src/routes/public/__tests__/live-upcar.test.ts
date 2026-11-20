import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  cfg: null as unknown,
  snapshot: null as unknown,
  days: [] as unknown[],
  missing: false,
  row: null as unknown,
  rpc: vi.fn(),
}));

vi.mock("@/services/live-stunt/config", async (orig) => ({
  ...(await orig<typeof import("@/services/live-stunt/config")>()),
  readLiveRun: async (slug: string) => ((h.cfg as { slug?: string } | null)?.slug === slug ? h.cfg : null),
  readLiveRuns: async () => (h.cfg ? [h.cfg] : []),
}));

vi.mock("@/services/tenant-client", () => {
  const q = (result: () => { data: unknown; error: unknown }) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit", "eq"]) b[m] = () => b;
    b.maybeSingle = async () => result();
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok);
    return b;
  };
  return {
    asTenantId: (s: string) => s,
    tenantRpc: (...a: unknown[]) => h.rpc(...a),
    tenantClient: () => ({
      from: (t: string) =>
        q(() => {
          if (h.missing) return { data: null, error: { code: "42P01" } };
          if (t === "live_stunt_snapshots") return { data: h.snapshot ? [{ payload: h.snapshot }] : [], error: null };
          if (h.row) return { data: h.row, error: null };
          return { data: h.days, error: null };
        }),
    }),
  };
});

import { publicLiveUpcar, publicLivePill, getLiveUpcarReview, postLiveUpcarReview, __resetLiveUpcarCache } from "../live-upcar";
import { realRun } from "@/services/live-stunt/__tests__/fixtures";
import { hashToken } from "@/services/live-stunt/token";

function res() {
  const r: { statusCode: number; body: unknown; headers: Record<string, string> } = { statusCode: 200, body: null, headers: {} };
  const o = {
    status(c: number) { r.statusCode = c; return o; },
    set(k: string | Record<string, string>, v?: string) { if (typeof k === "string") r.headers[k] = v!; else Object.assign(r.headers, k); return o; },
    json(b: unknown) { r.body = b; return o; },
  };
  return { r, o: o as unknown as Response };
}
const req = (x: Partial<Request>) => ({ query: {}, body: {}, ...x, params: { slug: "upcar", ...((x.params as object) ?? {}) } }) as unknown as Request;
const CFG = realRun({ start_at: "2099-01-01T00:00:00Z", unlock_at: "2099-01-10T00:00:00Z", end_at: "2099-02-01T00:00:00Z" });

beforeEach(() => {
  __resetLiveUpcarCache();
  Object.assign(h, { cfg: CFG, snapshot: null, days: [], missing: false, row: null });
  h.rpc.mockReset();
  delete process.env.LIVE_STUNT_DEMO;
});

describe("GET /api/public/live/upcar", () => {
  it("404 for a private run or an unknown slug", async () => {
    h.cfg = { ...CFG, public: false };
    const a = res(); await publicLiveUpcar(req({}), a.o);
    h.cfg = CFG;
    const b = res(); await publicLiveUpcar(req({ params: { slug: "other" } as never }), b.o);
    expect([a.r.statusCode, b.r.statusCode]).toEqual([404, 404]);
  });
  it("the pill points only at a public run with home_pill", async () => {
    const a = res(); await publicLivePill(req({}), a.o);
    expect(a.r.body).toEqual({ pill: null });
    h.cfg = { ...CFG, home_pill: true };
    const b = res(); await publicLivePill(req({}), b.o);
    expect(b.r.body).toEqual({ pill: { slug: "upcar", ended: false } });
  });
  it("a run past its end still names its slug, and says it ended", async () => {
    h.cfg = { ...CFG, home_pill: true, end_at: "2020-01-01T00:00:00Z" };
    const a = res(); await publicLivePill(req({}), a.o);
    expect(a.r.body).toEqual({ pill: { slug: "upcar", ended: true } });
  });
  it("404 when the feature is off", async () => {
    h.cfg = null;
    const { r, o } = res();
    await publicLiveUpcar(req({}), o);
    expect(r.statusCode).toBe(404);
  });
  it("missing tables: 200 loading payload", async () => {
    h.missing = true;
    const { r, o } = res();
    await publicLiveUpcar(req({}), o);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ numbers: null, days: [] });
  });
  it("locked: numbers are null even with a snapshot", async () => {
    h.snapshot = { taken_at: "x", day: 3, pace: { bookings_per_week: 1, hosts_per_week: 1 }, last_review_at: null, changes_today: 0, channels_today: [], by_day: [{ day: "2026-10-01", bookings: 5, hosts: 5, spent_usd: 100 }] };
    const { r, o } = res();
    await publicLiveUpcar(req({}), o);
    expect(r.body).toMatchObject({ locked: true, numbers: null });
  });
  it("demo mode serves the fixture, and ?locked=1 hides numbers", async () => {
    process.env.LIVE_STUNT_DEMO = "1";
    h.cfg = null;
    const a = res(); await publicLiveUpcar(req({}), a.o);
    expect(a.r.body).toMatchObject({ as_of: "demo", locked: false });
    const b = res(); await publicLiveUpcar(req({ query: { locked: "1" } as never }), b.o);
    expect(b.r.body).toMatchObject({ locked: true, numbers: null });
  });
});

describe("review routes", () => {
  it("GET with a wrong token is 404; the right one returns the draft", async () => {
    h.row = { day: "2026-10-03", status: "draft", full_entry: {}, neutral_entry: {}, edited_headline: null, edited_why: null, edited_kind: null, token_hash: hashToken("good"), token_expires_at: "2099-01-01T00:00:00Z" };
    const bad = res(); await getLiveUpcarReview(req({ params: { day: "2026-10-03" } as never, query: { t: "nope" } as never }), bad.o);
    expect(bad.r.statusCode).toBe(404);
    const ok = res(); await getLiveUpcarReview(req({ params: { day: "2026-10-03" } as never, query: { t: "good" } as never }), ok.o);
    expect(ok.r.statusCode).toBe(200);
    expect(ok.r.headers["Referrer-Policy"]).toBe("no-referrer");
  });
  it("POST publish applies once; a replay is 404", async () => {
    h.rpc.mockResolvedValueOnce({ data: "ok", error: null }).mockResolvedValueOnce({ data: "invalid", error: null });
    const body = { t: "good", action: "publish" };
    const a = res(); await postLiveUpcarReview(req({ params: { day: "2026-10-03" } as never, body }), a.o);
    const b = res(); await postLiveUpcarReview(req({ params: { day: "2026-10-03" } as never, body }), b.o);
    expect(a.r.statusCode).toBe(200);
    expect(b.r.statusCode).toBe(404);
    expect(h.rpc.mock.calls[0][2]).toMatchObject({ p_run_slug: "upcar", p_token_hash: hashToken("good"), p_action: "publish" });
  });
  it("POST with an identifier in the headline is 422 and never reaches the DB", async () => {
    const { r, o } = res();
    await postLiveUpcarReview(req({ params: { day: "2026-10-03" } as never, body: { t: "good", action: "publish", headline: "Raised customers/123/x" } }), o);
    expect(r.statusCode).toBe(422);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("POST with an unknown action or kind is 400", async () => {
    const a = res(); await postLiveUpcarReview(req({ params: { day: "2026-10-03" } as never, body: { t: "g", action: "delete" } }), a.o);
    const b = res(); await postLiveUpcarReview(req({ params: { day: "2026-10-03" } as never, body: { t: "g", action: "publish", kind: "EPIC" } }), b.o);
    expect([a.r.statusCode, b.r.statusCode]).toEqual([400, 400]);
  });
});
