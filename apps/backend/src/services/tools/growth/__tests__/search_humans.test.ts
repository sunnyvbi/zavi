
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: vi.fn(),
}));

import { searchHumanMembersTool, normalizeLane } from "../search_humans";
import { creatorBookPackageTool } from "@/services/tools/creators/creator_book_package";
import { tenantRpc } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";

const mockRpc = tenantRpc as unknown as ReturnType<typeof vi.fn>;

const ctx = { tenant_id: "tenant-A", log: () => {}, run_id: "run-abc" };

const approvedRow = {
  human_member_id: "cccccccc-0000-0000-0000-000000000001",
  slug: "ada",
  display_name: "Ada UGC",
  lanes: ["ugc_video"],
  niches: ["ugc", "tiktok", "beauty"],
  platforms: ["instagram", "tiktok"],
  city: "Nashville",
  country_code: "US",
  bookable: true,
  intro_video_path: "ada/intro.mp4",
  self_reported_metrics: { followers: 42000 },
  from_price_cents: 25000,
  joined_at: "2026-08-01T00:00:00Z",
  order_applied: "newest",
};

function stubRpc(result: { data?: unknown; error?: { message: string } | null }) {
  mockRpc.mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });
}

const PII_FIELD_NAMES = [
  "legal_name",
  "email",
  "date_of_birth",
  "tin_sha256",
  "payout_ref_hash",
  "auth_user_id",
  "rejected_reason",
  "profile",
  "handles",
  "handle",
];

describe("growth_search_human_members — PII boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns NO pii field names — asserted on the actual key set of a candidate", async () => {
    stubRpc({ data: [approvedRow] });
    const out = (await searchHumanMembersTool.execute(ctx, {})) as {
      candidates: Array<Record<string, unknown>>;
    };
    const keys = Object.keys(out.candidates[0]).sort();
    expect(keys).toEqual(
      [
        "human_member_id",
        "slug",
        "display_name",
        "lanes",
        "niches",
        "platforms",
        "city",
        "country_code",
        "bookable",
        "self_reported_metrics",
        "from_price_usd",
        "packages",
      ].sort(),
    );
    for (const pii of PII_FIELD_NAMES) {
      expect(keys, `candidate leaked '${pii}'`).not.toContain(pii);
    }
  });

  it("DROPS a PII column even if the RPC were ever widened to return one", async () => {
    stubRpc({
      data: [
        {
          ...approvedRow,
          email: "ada@example.com",
          legal_name: "Ada Lovelace",
          payout_ref_hash: "\\xdeadbeef",
        },
      ],
    });
    const out = (await searchHumanMembersTool.execute(ctx, {})) as {
      candidates: Array<Record<string, unknown>>;
    };
    const serialized = JSON.stringify(out);
    expect(Object.keys(out.candidates[0])).not.toContain("email");
    expect(Object.keys(out.candidates[0])).not.toContain("legal_name");
    expect(Object.keys(out.candidates[0])).not.toContain("payout_ref_hash");
    expect(serialized).not.toContain("ada@example.com");
    expect(serialized).not.toContain("Ada Lovelace");
    expect(serialized).not.toContain("deadbeef");
  });

  it("shows PLATFORMS and never a social handle (spec Q13: contact stays on Zavi)", async () => {
    stubRpc({ data: [{ ...approvedRow, handles: [{ platform: "tiktok", handle: "@adaugc" }] }] });
    const out = (await searchHumanMembersTool.execute(ctx, {})) as {
      candidates: Array<{ platforms: string[] }>;
    };
    expect(out.candidates[0].platforms).toEqual(["instagram", "tiktok"]);
    expect(JSON.stringify(out)).not.toContain("@adaugc");
  });
});

describe("growth_search_human_members — invariant 4, Zavi does not rank", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls the NEUTRAL search_creators RPC, never the rate-ranked search_human_members", async () => {
    stubRpc({ data: [approvedRow] });
    await searchHumanMembersTool.execute(ctx, {});
    const [, rpcName, args] = mockRpc.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(rpcName).toBe("search_creators");
    expect(rpcName).not.toBe("search_human_members");
    expect(args.p_order).toBe("newest");
  });

  it("reports the order the list came in, so the agent has to say it", async () => {
    stubRpc({ data: [approvedRow] });
    const out = (await searchHumanMembersTool.execute(ctx, {})) as {
      order_applied: string;
      notice: string;
    };
    expect(out.order_applied).toBe("newest");
    expect(out.notice).toMatch(/not ranked/i);
    expect(out.notice).toMatch(/does not score fit or quality/i);
  });

  it("prefers the order the DATABASE echoed over the one we asked for", async () => {
    stubRpc({ data: [{ ...approvedRow, order_applied: "a_to_z" }] });
    const out = (await searchHumanMembersTool.execute(ctx, {})) as { order_applied: string };
    expect(out.order_applied).toBe("a_to_z");
  });

  it("its own description tells the model the list is not ranked", () => {
    expect(searchHumanMembersTool.description).toMatch(/NOT RANKED/);
  });

  it("has no ordering or ranking input a model could ask for", () => {
    const shape = (searchHumanMembersTool.input_schema as unknown as { shape: Record<string, unknown> })
      .shape;
    for (const banned of ["order", "sort", "rank", "best", "top"]) {
      expect(Object.keys(shape).join(","), `input exposes '${banned}'`).not.toContain(banned);
    }
  });

  it("says a creator Zavi cannot pay yet must not be proposed (invariant 7)", async () => {
    stubRpc({ data: [{ ...approvedRow, country_code: "IN", bookable: false }] });
    const out = (await searchHumanMembersTool.execute(ctx, {})) as {
      candidates: Array<{ bookable: boolean }>;
      notice: string;
    };
    expect(out.candidates[0].bookable).toBe(false);
    expect(out.notice).toMatch(/bookable=false/);
  });
});

describe("growth_search_human_members — C8 trust boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has NO tenant_id field in its input schema", () => {
    const shape = (searchHumanMembersTool.input_schema as unknown as { shape: Record<string, unknown> })
      .shape;
    expect(Object.keys(shape)).not.toContain("tenant_id");
    expect(Object.keys(shape).sort()).toEqual(["lane", "max_rate_usd", "skills"]);
  });

  it("a model-supplied tenant_id cannot reach the query", async () => {
    stubRpc({ data: [approvedRow] });
    await searchHumanMembersTool.execute(ctx, {
      lane: "ugc_video",
      tenant_id: "tenant-EVIL",
      p_tenant_id: "tenant-EVIL",
    } as never);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [scope, rpcName, args] = mockRpc.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(scope).toBe("tenant-A");
    expect(rpcName).toBe("search_creators");
    expect(Object.keys(args).sort()).toEqual(
      ["p_lane", "p_limit", "p_max_price_cents", "p_niches", "p_order"].sort(),
    );
    expect(JSON.stringify(args)).not.toContain("tenant-EVIL");
  });

  it("does not import serviceClient (tenant-isolation gate)", () => {
    const SRC = readFileSync(join(__dirname, "..", "search_humans.ts"), "utf-8")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(SRC).not.toMatch(/serviceClient/);
    expect(SRC).toMatch(/import \{ tenantRpc, asTenantId \} from "@\/services\/tenant-client"/);
  });
});

describe("growth_search_human_members — filters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the lane filter through", async () => {
    stubRpc({ data: [approvedRow] });
    const out = (await searchHumanMembersTool.execute(ctx, { lane: "ugc_video" })) as {
      count: number;
      filters: { lane: string | null };
    };
    const args = mockRpc.mock.calls[0][2] as Record<string, unknown>;
    expect(args.p_lane).toBe("ugc_video");
    expect(out.count).toBe(1);
    expect(out.filters.lane).toBe("ugc_video");
  });

  it("accepts the older discipline words so an existing prompt keeps working", () => {
    expect(normalizeLane("ugc_creator")).toBe("ugc_video");
    expect(normalizeLane("ugc")).toBe("ugc_video");
    expect(normalizeLane("influencer")).toBe("influencer");
    expect(normalizeLane("audience_post")).toBe("audience_post");
    expect(normalizeLane("post")).toBe("post");
    expect(normalizeLane("UGC_Video")).toBe("ugc_video");
    expect(normalizeLane("")).toBeNull();
    expect(normalizeLane(null)).toBeNull();
    expect(normalizeLane("designer")).toBe("designer");
  });

  it("an unopened lane returns empty rather than erroring", async () => {
    stubRpc({ data: [] });
    const out = (await searchHumanMembersTool.execute(ctx, { lane: "designer" })) as {
      candidates: unknown[];
      count: number;
      next_step: string;
    };
    expect(out.candidates).toEqual([]);
    expect(out.count).toBe(0);
    expect(out.next_step).toMatch(/no approved creator matched/i);
    expect(out.next_step).toMatch(/do not invent/i);
    expect(out.next_step).toMatch(/DM creators yourself/);
  });

  it("counts who Zavi can book, and only asks for the DM card when that is nobody", async () => {
    stubRpc({ data: [{ ...approvedRow, bookable: false }] });
    const none = (await searchHumanMembersTool.execute(ctx, {})) as { bookable_count: number; next_step: string };
    expect(none.bookable_count).toBe(0);
    expect(none.next_step).toMatch(/DM creators yourself/);

    vi.clearAllMocks();
    stubRpc({ data: [{ ...approvedRow, bookable: true }] });
    const some = (await searchHumanMembersTool.execute(ctx, {})) as { bookable_count: number; next_step: string };
    expect(some.bookable_count).toBe(1);
    expect(some.next_step).toMatch(/book a creator directly/);
    expect(some.next_step).not.toMatch(/DM creators yourself/);
  });

  it("sends skills as null when none were given", async () => {
    stubRpc({ data: [] });
    await searchHumanMembersTool.execute(ctx, {});
    expect((mockRpc.mock.calls[0][2] as Record<string, unknown>).p_niches).toBeNull();
  });

  it("turns the USD rate ceiling into integer cents, rounding UP", async () => {
    stubRpc({ data: [] });
    await searchHumanMembersTool.execute(ctx, { max_rate_usd: 300 });
    expect((mockRpc.mock.calls[0][2] as Record<string, unknown>).p_max_price_cents).toBe(30000);

    vi.clearAllMocks();
    stubRpc({ data: [] });
    await searchHumanMembersTool.execute(ctx, { max_rate_usd: 99.999 });
    expect((mockRpc.mock.calls[0][2] as Record<string, unknown>).p_max_price_cents).toBe(10000);
  });

  it("reports the starting price in dollars", async () => {
    stubRpc({ data: [approvedRow] });
    const out = (await searchHumanMembersTool.execute(ctx, {})) as {
      candidates: Array<{ from_price_usd: number | null }>;
    };
    expect(out.candidates[0].from_price_usd).toBe(250);
  });

  it("turns a DB error VALUE (not a throw) into a recoverable ExpectedToolError", async () => {
    stubRpc({ data: null, error: { message: "boom" } });
    await expect(searchHumanMembersTool.execute(ctx, {})).rejects.toBeInstanceOf(ExpectedToolError);
  });
});

describe("growth_search_human_members — Zavi proposes, the founder approves every hire", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("an agent without the creator tools is still told the OPERATOR selects and contacts no one", async () => {
    stubRpc({ data: [approvedRow] });
    const out = (await searchHumanMembersTool.execute({ ...ctx, agent_slug: "operator" }, {})) as { next_step: string };
    expect(out.next_step).toMatch(/operator selects/i);
    expect(out.next_step).toMatch(/contact anyone/i);
    expect(out.next_step).not.toMatch(/creator__/);
  });

  it("the ugc channel is told a hire goes through the creator tools and waits for the founder", async () => {
    stubRpc({ data: [approvedRow] });
    const out = (await searchHumanMembersTool.execute({ ...ctx, agent_slug: "ugc" }, {})) as { next_step: string };
    expect(out.next_step).toMatch(/creator__book_package/);
    expect(out.next_step).toMatch(/creator__offer/);
    expect(out.next_step).toMatch(/founder approves every hire/i);
    expect(out.next_step).toMatch(/do not write a DM or sourcing step/i);
  });

  it("hands the hiring agent a package_id creator__book_package accepts, for the searched lane only, with no handle or package copy", async () => {
    const ugcPkg = "aaaaaaaa-1111-4111-8111-000000000001";
    const postPkg = "aaaaaaaa-1111-4111-8111-000000000002";
    stubRpc({
      data: [
        {
          ...approvedRow,
          handles: [{ platform: "tiktok", handle: "@adaugc", followers: 42000 }],
          packages: [
            { id: ugcPkg, kind: "ugc_video", title: "3 hook videos", description: "DM me at ada@example.com", price_cents: 25000, currency: "usd", delivery_days: 7 },
            { id: postPkg, kind: "audience_post", title: "One reel", description: "x", price_cents: 40000, currency: "usd", delivery_days: 5 },
          ],
        },
        {
          ...approvedRow,
          human_member_id: "cccccccc-0000-0000-0000-000000000002",
          bookable: false,
          packages: [{ id: "aaaaaaaa-1111-4111-8111-000000000003", kind: "ugc_video", title: "Unpayable", price_cents: 100, delivery_days: 3 }],
        },
      ],
    });
    const out = (await searchHumanMembersTool.execute({ ...ctx, agent_slug: "ugc" }, { lane: "ugc" })) as {
      candidates: Array<{ packages: Array<Record<string, unknown>> }>;
      next_step: string;
    };
    expect(out.candidates[0].packages).toEqual([
      { package_id: ugcPkg, title: "3 hook videos", kind: "ugc_video", price_usd: 250, delivery_days: 7 },
    ]);
    expect(out.candidates[1].packages).toEqual([]);
    expect(creatorBookPackageTool.input_schema.safeParse({ package_id: out.candidates[0].packages[0].package_id }).success).toBe(true);
    expect(out.next_step).toMatch(/package_id/);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("@adaugc");
    expect(serialized).not.toContain("ada@example.com");
    expect(serialized).not.toContain(postPkg);
  });

  it("lists every active package when no lane is searched", async () => {
    stubRpc({
      data: [
        {
          ...approvedRow,
          packages: [
            { id: "aaaaaaaa-1111-4111-8111-000000000001", kind: "ugc_video", title: "A", price_cents: 25050, delivery_days: null },
            { id: "aaaaaaaa-1111-4111-8111-000000000002", kind: "audience_post", title: "B", price_cents: 40000, delivery_days: 5 },
          ],
        },
      ],
    });
    const out = (await searchHumanMembersTool.execute(ctx, {})) as { candidates: Array<{ packages: Array<Record<string, unknown>> }> };
    expect(out.candidates[0].packages.map((p) => [p.package_id, p.price_usd, p.delivery_days])).toEqual([
      ["aaaaaaaa-1111-4111-8111-000000000001", 250.5, null],
      ["aaaaaaaa-1111-4111-8111-000000000002", 400, 5],
    ]);
  });

  it("labels self-reported metrics as self-reported", async () => {
    stubRpc({ data: [approvedRow] });
    const out = (await searchHumanMembersTool.execute(ctx, {})) as { notice: string };
    expect(out.notice).toMatch(/self-reported/i);
  });
});

describe("the ranked RPC is the one we moved OFF", () => {
  const MIGRATIONS = join(
    __dirname,
    "..", "..", "..", "..", "..", "..", "..",
    "supabase",
    "migrations",
  );

  it("search_human_members really did order by skill overlap then cheapest rate", () => {
    const sql = readFileSync(
      join(MIGRATIONS, "20260904121802_rename_bench_to_humans.sql"),
      "utf-8",
    );
    expect(sql).toMatch(/order by/i);
    expect(sql.toLowerCase()).toMatch(/rate_usd/);
  });

  it("the tool's source names search_creators and not search_human_members", () => {
    const SRC = readFileSync(join(__dirname, "..", "search_humans.ts"), "utf-8")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(SRC).toContain('"search_creators"');
    expect(SRC).not.toContain('"search_human_members"');
  });
});

describe("growth_search_human_members — niches match how creators store them", () => {
  type Creator = { id: string; skills: string[]; created_at: string };
  let network: Creator[] = [];

  function fakeSearchCreators() {
    mockRpc.mockImplementation(async (_tenant: string, fn: string, args: Record<string, unknown>) => {
      if (fn !== "search_creators") throw new Error(`unexpected rpc ${fn}`);
      const niches = args.p_niches as string[] | null | undefined;
      const limit = Math.min(Math.max((args.p_limit as number | undefined) ?? 50, 1), 100);
      const rows = network
        .filter((c) => !niches || niches.length === 0 || c.skills.some((s) => niches.includes(s)))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, limit)
        .map((c) => ({ ...approvedRow, human_member_id: c.id, niches: c.skills, bookable: true }));
      return { data: rows, error: null };
    });
  }

  const creator = (i: number, skills: string[]): Creator => ({
    id: `c-${String(i).padStart(4, "0")}`,
    skills,
    created_at: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
  });

  type Out = {
    candidates: Array<{ human_member_id: string }>;
    count: number;
    more_available: boolean;
    filters: { skills: string[]; ignored_skills: string[] };
    next_step: string;
    notice: string;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    network = [creator(1, ["Beauty", "Lifestyle"]), creator(2, ["Food and drink"]), creator(3, ["Tech", "Apps"])];
    fakeSearchCreators();
  });

  it("finds the Beauty creator when the model asks for ['ugc','beauty'], and says ugc was not searched", async () => {
    const out = (await searchHumanMembersTool.execute(ctx, { skills: ["ugc", " beauty "] })) as Out;
    expect((mockRpc.mock.calls[0][2] as Record<string, unknown>).p_niches).toEqual(["Beauty"]);
    expect(out.candidates.map((c) => c.human_member_id)).toEqual(["c-0001"]);
    expect(out.next_step).not.toMatch(/DM creators yourself/);
    expect(out.filters.skills).toEqual(["Beauty"]);
    expect(out.filters.ignored_skills).toEqual(["ugc"]);
    expect(out.notice).toMatch(/ignored_skills/);
  });

  it("maps a word of a niche and a plural, and dedupes case variants", async () => {
    const out = (await searchHumanMembersTool.execute(ctx, { skills: ["FOOD", "app", "APPS", "Food and Drink"] })) as Out;
    expect((mockRpc.mock.calls[0][2] as Record<string, unknown>).p_niches).toEqual(["Food and drink", "Apps"]);
    expect(out.candidates.map((c) => c.human_member_id)).toEqual(["c-0003", "c-0002"]);
    expect(out.filters.ignored_skills).toEqual([]);
    expect(out.notice).not.toMatch(/ignored_skills/);
  });

  it("returns nobody and never queries when the only skill, ugc, is not a niche", async () => {
    const out = (await searchHumanMembersTool.execute(ctx, { skills: ["ugc"] })) as Out;
    expect(mockRpc).not.toHaveBeenCalled();
    expect(out.candidates).toEqual([]);
    expect(out.count).toBe(0);
    expect(out.more_available).toBe(false);
    expect(out.filters).toMatchObject({ skills: [], ignored_skills: ["ugc"] });
    expect(out.notice).toMatch(/ignored_skills/);
    expect(out.notice).toMatch(/Beauty/);
    expect(out.next_step).toMatch(/again/);
  });

  it("returns nobody when every one of several skills is unmapped, even with a lane and a rate", async () => {
    const out = (await searchHumanMembersTool.execute(ctx, {
      skills: ["ugc", "demo", "  "],
      max_rate_usd: 500,
    })) as Out;
    expect(mockRpc).not.toHaveBeenCalled();
    expect(out.count).toBe(0);
    expect(out.filters).toMatchObject({ skills: [], ignored_skills: ["ugc", "demo"] });
  });

  it("still lists everyone when the only skill is blank", async () => {
    const out = (await searchHumanMembersTool.execute(ctx, { skills: ["  "] })) as Out;
    expect((mockRpc.mock.calls[0][2] as Record<string, unknown>).p_niches).toBeNull();
    expect(out.count).toBe(3);
  });

  it("lists the real niche values in the skills description", () => {
    const shape = (searchHumanMembersTool.input_schema as unknown as {
      shape: { skills: { description?: string } };
    }).shape;
    const text = shape.skills.description ?? "";
    expect(text).toMatch(/Food and drink/);
    expect(text).not.toMatch(/'ugc'/);
  });

  it("asks for 100 creators, not the RPC default of 50, and flags a full page", async () => {
    network = Array.from({ length: 150 }, (_, i) => creator(i, ["Beauty"]));
    const out = (await searchHumanMembersTool.execute(ctx, { skills: ["beauty"] })) as Out;
    expect((mockRpc.mock.calls[0][2] as Record<string, unknown>).p_limit).toBe(100);
    expect(out.count).toBe(100);
    expect(out.more_available).toBe(true);
    expect(out.notice).toMatch(/not the total/);
  });

  it("does not flag more when the page is not full", async () => {
    network = Array.from({ length: 99 }, (_, i) => creator(i, ["Beauty"]));
    const out = (await searchHumanMembersTool.execute(ctx, {})) as Out;
    expect(out.count).toBe(99);
    expect(out.more_available).toBe(false);
    expect(out.notice).not.toMatch(/not the total/);
  });
});
