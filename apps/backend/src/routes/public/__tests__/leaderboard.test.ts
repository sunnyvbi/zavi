
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ settings: {} as Record<string, boolean>, rows: [] as unknown[], fail: false }));

vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async (k: string) => H.settings[k] ?? false),
}));
vi.mock("@/services/tenant-client", () => {
  const make = () => {
    const chain: Record<string, unknown> = {};
    let optOutRead = false;
    for (const m of ["select", "eq", "is", "not", "gt", "order", "range"])
      chain[m] = (...a: unknown[]) => {
        if (m === "not" && a[0] === "revoked_at") optOutRead = true;
        return chain;
      };
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      (H.fail
        ? Promise.resolve({ data: null, error: { message: "db down" } })
        : Promise.resolve({ data: optOutRead ? [] : H.rows, error: null })
      ).then(res, rej);
    return chain;
  };
  return { globalClient: () => ({ from: () => make() }) };
});

import { leaderboardList, leaderboardRank } from "../leaderboard";
import { resetLeaderboardCache } from "@/services/start-card/leaderboard";

function mkRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
  };
  return res as unknown as import("express").Response & { statusCode: number; body: any; headers: Record<string, string> };
}

const req = (query: Record<string, unknown> = {}, params: Record<string, string> = {}) =>
  ({ query, params }) as unknown as import("express").Request;

function dbRow(domain: string, total: number, public_id: string) {
  return {
    id: "row-uuid-secret",
    ip_hash: "iphashsecret",
    public_id,
    domain,
    locale: "US",
    score: { total, out_of: 100, by_check: { google: 20, ai: 20, seo: 20, design: 20, compare: 20 } },
    created_at: "2026-10-02T00:00:00.000Z",
    evidence: { raw: "secret" },
    profile: {
      state: "done",
      fetched_at: null,
      evidence: { company_name: "X", category: "x", search_term: "x", country: "US", country_from: "address", rivals: [], company_type: "ecommerce" },
    },
    diagnosis: { state: "done", fetched_at: null, evidence: { constraint: { check_key: "ai", title: "No AI engine names you", why: "secret why" }, action_this_week: { title: "t", why: "w" } } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLeaderboardCache();
  H.settings = { growth_leaderboard_enabled: true };
  H.fail = false;
  H.rows = [dbRow("alpha.com", 90, "AAAAAAAAAAAAAAAA"), dbRow("beta.com", 80, "BBBBBBBBBBBBBBBB")];
});

describe("GET /api/public/leaderboard", () => {
  it("returns { total, rows, generated_at } with only the public row fields", async () => {
    const res = mkRes();
    await leaderboardList(req(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(2);
    expect(typeof res.body.generated_at).toBe("string");
    expect(res.body.rows[0]).toEqual({
      rank: 1,
      public_id: "AAAAAAAAAAAAAAAA",
      domain: "alpha.com",
      score: { total: 90, out_of: 100 },
      category: "ecommerce",
      country: "US",
      constraint: "No AI engine names you",
      is_new: true,
    });
    const text = JSON.stringify(res.body);
    for (const leak of ["row-uuid-secret", "iphashsecret", "secret", "by_check", "ip_hash"]) expect(text).not.toContain(leak);
  });

  it("applies filters and paging", async () => {
    const res = mkRes();
    await leaderboardList(req({ q: "beta", limit: "10", offset: "0" }), res);
    expect(res.body.total).toBe(1);
    expect(res.body.rows.map((r: { domain: string }) => r.domain)).toEqual(["beta.com"]);
  });

  it("400s a bad filter or an oversized page", async () => {
    for (const q of [{ category: "crypto" }, { country: "XX" }, { limit: "101" }, { offset: "-1" }, { q: "x".repeat(101) }]) {
      const res = mkRes();
      await leaderboardList(req(q), res);
      expect(res.statusCode, JSON.stringify(q)).toBe(400);
    }
  });

  it("404s while the kill switch is off", async () => {
    H.settings.growth_leaderboard_enabled = false;
    const res = mkRes();
    await leaderboardList(req(), res);
    expect(res.statusCode).toBe(404);
  });

  it("500s without detail when the read fails", async () => {
    H.fail = true;
    const res = mkRes();
    await leaderboardList(req(), res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("db down");
  });
});

describe("GET /api/public/leaderboard/rank/:public_id", () => {
  it("returns the rank and total for a listed card, listed:false otherwise", async () => {
    const res = mkRes();
    await leaderboardRank(req({}, { public_id: "BBBBBBBBBBBBBBBB" }), res);
    expect(res.body).toEqual({ listed: true, rank: 2, total: 2 });
    const miss = mkRes();
    await leaderboardRank(req({}, { public_id: "CCCCCCCCCCCCCCCC" }), miss);
    expect(miss.body).toEqual({ listed: false });
  });

  it("404s a malformed id without reading, and while the switch is off", async () => {
    for (const id of ["short", "has-dash-0000000000", "x".repeat(40)]) {
      const res = mkRes();
      await leaderboardRank(req({}, { public_id: id }), res);
      expect(res.statusCode).toBe(404);
    }
    H.settings.growth_leaderboard_enabled = false;
    const off = mkRes();
    await leaderboardRank(req({}, { public_id: "AAAAAAAAAAAAAAAA" }), off);
    expect(off.statusCode).toBe(404);
  });
});
