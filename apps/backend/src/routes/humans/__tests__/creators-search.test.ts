
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { requireAuthMock, authState } = vi.hoisted(() => {
  const s = { auth: { user_id: "u-1", tenant_id: "tenant-A", access_token: "tok" } as unknown };
  return { requireAuthMock: vi.fn(async () => s.auth), state: s, authState: s };
});
vi.mock("@/services/auth/middleware", () => ({ requireAuth: requireAuthMock }));

const { tenantRpcMock } = vi.hoisted(() => ({
  tenantRpcMock: vi.fn(),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: tenantRpcMock,
}));

const { searchInvitedMock } = vi.hoisted(() => ({ searchInvitedMock: vi.fn() }));
vi.mock("@/services/creators/invite-messages", async (orig) => ({
  ...(await orig<typeof import("@/services/creators/invite-messages")>()),
  searchInvitedCreators: searchInvitedMock,
}));

import { searchCreators, MAX_SEARCH_OFFSET, FILTER_LABELS, FILTER_OPTIONS, NEUTRAL_ORDERS, NEUTRALITY_NOTE, RESULTS_NOTES } from "../creators";
import { BUSINESS_FEE_BPS } from "@zavi/shared";
import { CREATOR_PAYOUT_COUNTRIES } from "@/services/creators/payout-countries";

type Json = Record<string, unknown>;

function mockRes() {
  const out = { code: 200, body: null as Json | null, headers: {} as Record<string, string> };
  const res = {
    status(c: number) {
      out.code = c;
      return res;
    },
    json(b: Json) {
      out.body = b;
      return res;
    },
    set(k: string, v: string) {
      out.headers[k] = v;
      return res;
    },
  };
  return { res: res as never, out };
}

const row = {
  human_member_id: "cccccccc-0000-0000-0000-000000000001",
  slug: "ada",
  display_name: "Ada Makes",
  lanes: ["ugc_video"],
  niches: ["ugc"],
  platforms: ["tiktok"],
  city: "Nashville",
  country_code: "US",
  bookable: true,
  intro_video_path: "ada/intro.mp4",
  self_reported_metrics: {
    self_reported: true,
    disclaimer: "Self-reported, not checked by Zavi",
    audience: [{ platform: "tiktok", followers: 42000, self_reported: true }],
  },
  from_price_cents: 15000,
  joined_at: "2026-08-01T00:00:00Z",
  order_applied: "newest",
};

beforeEach(() => {
  vi.clearAllMocks();
  authState.auth = { user_id: "u-1", tenant_id: "tenant-A", access_token: "tok" };
  process.env.SUPABASE_URL = "https://proj.supabase.co";
  tenantRpcMock.mockResolvedValue({ data: [row], error: null });
  searchInvitedMock.mockResolvedValue([]);
});

describe("invariant 4 — the list is never ranked, and the order is stated", () => {
  it("offers exactly two orders, both neutral", () => {
    expect([...NEUTRAL_ORDERS]).toEqual(["newest", "a_to_z"]);
  });

  it("refuses a ranked order before it reaches the database", async () => {
    for (const bad of ["best_match", "fit", "price", "cheapest", "rating", "relevance"]) {
      vi.clearAllMocks();
      const { res, out } = mockRes();
      await searchCreators({ query: { order: bad } } as never, res);
      expect(out.code, `'${bad}' must be refused`).toBe(400);
      expect(tenantRpcMock).not.toHaveBeenCalled();
    }
  });

  it("never sends a price or fit ordering argument to the RPC", async () => {
    const { res } = mockRes();
    await searchCreators({ query: { max_price_cents: "20000" } } as never, res);
    const args = tenantRpcMock.mock.calls[0][2] as Json;
    expect(args.p_order).toBe("newest");
    const serialized = JSON.stringify(args).toLowerCase();
    expect(serialized).not.toContain("order_by_price");
    expect(serialized).not.toContain("sort");
    expect(args.p_max_price_cents).toBe(20000);
  });

  it("echoes the order the DATABASE applied, not the one we asked for", async () => {
    tenantRpcMock.mockResolvedValue({
      data: [{ ...row, order_applied: "a_to_z" }],
      error: null,
    });
    const { res, out } = mockRes();
    await searchCreators({ query: { order: "newest" } } as never, res);
    expect(out.body?.order_applied).toBe("a_to_z");
  });

  it("always ships the words that say Zavi does not rank or pick", async () => {
    const { res, out } = mockRes();
    await searchCreators({ query: {} } as never, res);
    expect(out.body?.neutrality_note).toBe(NEUTRALITY_NOTE);
    expect(String(out.body?.neutrality_note)).toMatch(/does not rank/i);
    expect(String(out.body?.neutrality_note)).toMatch(/does not pick/i);
    expect(out.body?.order_label).toBe("Newest first");
  });
});

describe("filter options come from the server", () => {
  it("ships them with every result, so the screen has no list of its own", async () => {
    const { res, out } = mockRes();
    await searchCreators({ query: {} } as never, res);
    expect(out.body?.filter_options).toBe(FILTER_OPTIONS);
  });

  it("offers only values the search accepts", async () => {
    const accepted = async (query: Record<string, string>) => {
      tenantRpcMock.mockClear();
      const { res, out } = mockRes();
      await searchCreators({ query } as never, res);
      return out.code === 200 && tenantRpcMock.mock.calls.length === 1;
    };
    for (const o of FILTER_OPTIONS.lanes) expect(await accepted({ lane: o.value })).toBe(true);
    for (const o of FILTER_OPTIONS.platforms) expect(await accepted({ platform: o.value })).toBe(true);
    for (const o of FILTER_OPTIONS.max_price_cents) expect(await accepted({ max_price_cents: String(o.value) })).toBe(true);
    for (const o of FILTER_OPTIONS.max_delivery_days) expect(await accepted({ max_delivery_days: String(o.value) })).toBe(true);
    expect(await accepted({ niches: FILTER_OPTIONS.niches.map((o) => o.value).join(",") })).toBe(true);
  });

  it("no longer offers or searches the audience post lane", async () => {
    expect(FILTER_OPTIONS.lanes.map((o) => o.value)).toEqual(["ugc_video"]);
    for (const lane of ["audience_post", "influencer", "post"]) {
      tenantRpcMock.mockClear();
      const { res, out } = mockRes();
      await searchCreators({ query: { lane } } as never, res);
      expect(out.code, lane).toBe(400);
      expect(tenantRpcMock).not.toHaveBeenCalled();
    }
  });

  it("ships every word of the filter bar too, with the fee note read from the fee constant", async () => {
    const { res, out } = mockRes();
    await searchCreators({ query: {} } as never, res);
    expect(out.body?.filter_labels).toBe(FILTER_LABELS);
    expect(out.body?.results_notes).toBe(RESULTS_NOTES);
    for (const k of Object.keys(FILTER_OPTIONS)) expect(FILTER_LABELS).toHaveProperty(k);
    expect(RESULTS_NOTES.fee).toContain(`${BUSINESS_FEE_BPS / 100}%`);
  });

  it("lists exactly the payout countries, by name", () => {
    expect(FILTER_OPTIONS.countries.map((c) => c.value).sort()).toEqual([...CREATOR_PAYOUT_COUNTRIES].sort());
    expect(FILTER_OPTIONS.countries.find((c) => c.value === "GB")?.label).toBe("United Kingdom");
  });

  it("prices the package options in dollars", () => {
    expect(FILTER_OPTIONS.max_price_cents.find((o) => o.value === 5_000)?.label).toBe("A package up to $50");
    expect(FILTER_OPTIONS.max_price_cents.find((o) => o.value === 100_000)?.label).toBe("A package up to $1,000");
  });
});

describe("the tenant boundary", () => {
  it("takes the tenant from the verified session, never the query string", async () => {
    const { res } = mockRes();
    await searchCreators({ query: { tenant_id: "tenant-EVIL", p_tenant_id: "tenant-EVIL" } } as never, res);
    const [scope, name, args] = tenantRpcMock.mock.calls[0] as [string, string, Json];
    expect(scope).toBe("tenant-A");
    expect(name).toBe("search_creators");
    expect(JSON.stringify(args)).not.toContain("tenant-EVIL");
  });

  it("does nothing at all when requireAuth has already answered", async () => {
    authState.auth = null;
    const { res } = mockRes();
    await searchCreators({ query: {} } as never, res);
    expect(tenantRpcMock).not.toHaveBeenCalled();
  });

  it("403s a signed-in caller with no tenant (a creator, or a stranger) before any read", async () => {
    requireAuthMock.mockImplementationOnce((async (_req: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }) => {
      res.status(403).json({ error: { code: "no_active_tenant" } });
      return null;
    }) as never);
    const { res, out } = mockRes();
    await searchCreators({ query: {} } as never, res);
    expect(out.code).toBe(403);
    expect(tenantRpcMock).not.toHaveBeenCalled();
  });
});

describe("what a result row may contain", () => {
  it("carries no PII, even if the RPC were widened to return some", async () => {
    tenantRpcMock.mockResolvedValue({
      data: [{ ...row, email: "ada@example.com", legal_name: "Ada Lovelace", date_of_birth: "1990-01-01" }],
      error: null,
    });
    const { res, out } = mockRes();
    await searchCreators({ query: {} } as never, res);
    const serialized = JSON.stringify(out.body);
    expect(serialized).not.toContain("ada@example.com");
    expect(serialized).not.toContain("Ada Lovelace");
    expect(serialized).not.toContain("1990-01-01");
    const first = (out.body?.creators as Json[])[0];
    expect(Object.keys(first)).not.toContain("email");
    expect(Object.keys(first)).not.toContain("intro_video_path");
  });

  it("shows socials with SELF-REPORTED followers and a URL we built, never a stored string", async () => {
    tenantRpcMock.mockResolvedValue({
      data: [
        {
          ...row,
          handles: [
            { platform: "tiktok", handle: "ada", followers: 42000 },
            { platform: "instagram", handle: "javascript:alert(1)", followers: null },
          ],
        },
      ],
      error: null,
    });
    const { res, out } = mockRes();
    await searchCreators({ query: {} } as never, res);
    const first = (out.body?.creators as Json[])[0];
    expect(first.handles).toEqual([
      { platform: "tiktok", handle: "ada", url: "https://www.tiktok.com/@ada", followers: 42000, label: "Self-reported, not checked by Zavi" },
      { platform: "instagram", handle: "javascript:alert(1)", url: null, followers: null, label: "Self-reported, not checked by Zavi" },
    ]);
    expect(out.body?.self_reported_label).toBe("Self-reported, not checked by Zavi");
    expect(first).not.toHaveProperty("has_intro_video");
  });

  it("labels every audience number self-reported (invariant 3)", async () => {
    const { res, out } = mockRes();
    await searchCreators({ query: {} } as never, res);
    const first = (out.body?.creators as Json[])[0];
    const audience = first.self_reported_audience as Array<{
      self_reported: boolean;
      label: string;
      value: string;
    }>;
    expect(audience).toEqual([
      { label: "tiktok followers", value: "42000", self_reported: true },
    ]);
    for (const a of audience) expect(a.self_reported).toBe(true);
    expect(String(out.body?.self_reported_note)).toMatch(/self-reported/i);
  });

  it("shows the price AND the total with the Zavi fee (invariant 8)", async () => {
    const { res, out } = mockRes();
    await searchCreators({ query: {} } as never, res);
    const first = (out.body?.creators as Json[])[0];
    expect(first.from_price_cents).toBe(15000);
    expect(first.from_price_business_total_cents).toBe(16500);
  });

  it("replaces the booking affordance with an honest state outside the payout countries (invariant 7)", async () => {
    tenantRpcMock.mockResolvedValue({
      data: [{ ...row, country_code: "IN", bookable: false }],
      error: null,
    });
    const { res, out } = mockRes();
    await searchCreators({ query: {} } as never, res);
    const first = (out.body?.creators as Json[])[0];
    expect(first.bookable).toBe(false);
    expect(String(first.not_bookable_message)).toMatch(/cannot be booked yet/i);
  });

  it("reports an RPC failure instead of rendering an empty network", async () => {
    tenantRpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { res, out } = mockRes();
    await searchCreators({ query: {} } as never, res);
    expect(out.code).toBe(503);
  });
});

describe("search_creators migration — the ORDER BY is neutral", () => {
  const SQL = readFileSync(
    join(
      __dirname,
      "..", "..", "..", "..", "..", "..",
      "supabase",
      "migrations",
      "20260927100000_creator_storefront_off.sql",
    ),
    "utf-8",
  );
  const stripComments = (s: string) =>
    s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  const start = SQL.indexOf("create function search_creators");
  const BODY = stripComments(SQL.slice(start, SQL.indexOf("comment on function search_creators")));
  const ORDER_BY = BODY.slice(BODY.lastIndexOf("order by"), BODY.indexOf("limit least"));

  it("orders by created_at / display_name / id and nothing else", () => {
    expect(ORDER_BY).toMatch(/m\.created_at/);
    expect(ORDER_BY).toMatch(/lower\(m\.display_name\)/);
    expect(ORDER_BY).toMatch(/m\.id asc/);
    for (const banned of ["price", "rate", "rating", "score", "overlap", "cardinality", "avg", "followers"]) {
      expect(ORDER_BY, `ORDER BY mentions '${banned}'`).not.toContain(banned);
    }
  });

  it("raises on any order other than the two neutral ones", () => {
    expect(BODY).toMatch(/p_order not in \('newest', 'a_to_z'\)/);
  });

  it("echoes the order it applied back to the caller", () => {
    expect(BODY).toMatch(/order_applied\s+text/);
  });

  it("is approved-only and lists only creators Zavi can pay", () => {
    expect(BODY).toMatch(/m\.vetting_state = 'approved'/);
    expect(BODY).toMatch(/and creator_payout_country_supported\(m\.country_code\)/);
    expect(BODY).not.toMatch(/m\.slug is not null/);
  });

  it("returns handles with followers and packages, and never reads PII", () => {
    expect(BODY).toMatch(/handles\s+jsonb/);
    expect(BODY).toMatch(/'followers', h\.followers/);
    expect(BODY).toMatch(/packages\s+jsonb/);
    expect(BODY).not.toMatch(/human_member_pii|email|legal_name|date_of_birth/);
  });

  it("is NOT granted to anon — it is the tenant-authed search", () => {
    expect(SQL).toMatch(/revoke execute on function search_creators\([^)]*\)\s*\n\s*from public, anon, authenticated;/);
    expect(SQL).toMatch(/grant execute on function search_creators\([^)]*\)\s*\n\s*to service_role;/);
  });
});

describe("paging — has_more is true only when another row exists", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ ...row, human_member_id: `m-${i}` }));
  const invites = (n: number) => Array.from({ length: n }, (_, i) => ({ human_member_id: `invite:${i}` }));
  type Page = { has_more: boolean; offset: number; failed?: boolean };

  it("a full member page whose next row does not exist says no more (no empty extra page)", async () => {
    tenantRpcMock.mockResolvedValueOnce({ data: rows(2), error: null }).mockResolvedValueOnce({ data: [], error: null });
    const { res, out } = mockRes();
    await searchCreators({ query: { limit: "2", offset: "2" } } as never, res);
    expect((out.body?.page as Page).has_more).toBe(false);
    const probe = tenantRpcMock.mock.calls[1][2] as Json;
    expect(probe.p_offset).toBe(4);
    expect(probe.p_limit).toBe(1);
  });

  it("a full member page with a next row says more", async () => {
    tenantRpcMock.mockResolvedValueOnce({ data: rows(2), error: null }).mockResolvedValueOnce({ data: rows(1), error: null });
    const { res, out } = mockRes();
    await searchCreators({ query: { limit: "2" } } as never, res);
    expect((out.body?.page as Page).has_more).toBe(true);
  });

  it("a short member page reads no probe row", async () => {
    const { res, out } = mockRes();
    await searchCreators({ query: { limit: "2" } } as never, res);
    expect((out.body?.page as Page).has_more).toBe(false);
    expect(tenantRpcMock).toHaveBeenCalledTimes(1);
  });

  it("never says more past the deepest offset the route accepts", async () => {
    tenantRpcMock.mockResolvedValue({ data: rows(100), error: null });
    searchInvitedMock.mockResolvedValue(invites(101));
    const { res, out } = mockRes();
    await searchCreators({ query: { limit: "100", offset: String(MAX_SEARCH_OFFSET) } } as never, res);
    expect(out.code).toBe(200);
    expect((out.body?.page as Page).has_more).toBe(false);
    expect((out.body?.invited_page as Page).has_more).toBe(false);
  });

  it("invites: reads one past the page, returns the page, and says more only when that row exists", async () => {
    searchInvitedMock.mockResolvedValueOnce(invites(3));
    const { res, out } = mockRes();
    await searchCreators({ query: { limit: "2" } } as never, res);
    expect(searchInvitedMock.mock.calls[0][0]).toMatchObject({ limit: 3, offset: 0 });
    expect(out.body?.invited).toHaveLength(2);
    expect((out.body?.invited_page as Page).has_more).toBe(true);

    searchInvitedMock.mockResolvedValueOnce(invites(2));
    const second = mockRes();
    await searchCreators({ query: { limit: "2" } } as never, second.res);
    expect((second.out.body?.invited_page as Page).has_more).toBe(false);
  });

  it("invites resume from invited_offset when one is sent", async () => {
    const { res, out } = mockRes();
    await searchCreators({ query: { limit: "2", offset: "4", invited_offset: "2" } } as never, res);
    expect(searchInvitedMock.mock.calls[0][0]).toMatchObject({ offset: 2 });
    expect((out.body?.invited_page as Page).offset).toBe(2);
    expect((out.body?.page as Page).offset).toBe(4);
  });

  it("a failed invite read is reported, never passed off as the end of the list", async () => {
    searchInvitedMock.mockRejectedValueOnce(new Error("down"));
    const { res, out } = mockRes();
    await searchCreators({ query: {} } as never, res);
    expect(out.code).toBe(200);
    expect(out.body?.creators).toHaveLength(1);
    expect(out.body?.invited).toEqual([]);
    expect((out.body?.invited_page as Page).failed).toBe(true);
  });

  it("refuses an invited_offset past the cap", async () => {
    const { res, out } = mockRes();
    await searchCreators({ query: { invited_offset: String(MAX_SEARCH_OFFSET + 1) } } as never, res);
    expect(out.code).toBe(400);
  });
});
