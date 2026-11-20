
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: mocks.serviceClientMock,
}));

import { investorDbSearchTool } from "../search";

type Row = Record<string, unknown>;

function makeFakeClient(rows: Row[], opts?: { error?: { message: string } }) {
  const calls: { method: string; args: unknown[] }[] = [];

  const newQuery = () => {
    const overlapFilters: [string, string[]][] = [];
    const eqFilters: [string, unknown][] = [];
    const builder: Record<string, unknown> = {};
    const passthrough = (method: string) => (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
    builder.select = passthrough("select");
    builder.order = passthrough("order");
    builder.ilike = passthrough("ilike");
    builder.overlaps = (col: string, arr: string[]) => {
      calls.push({ method: "overlaps", args: [col, arr] });
      overlapFilters.push([col, arr]);
      return builder;
    };
    builder.eq = (col: string, val: unknown) => {
      calls.push({ method: "eq", args: [col, val] });
      eqFilters.push([col, val]);
      return builder;
    };
    builder.limit = (...args: unknown[]) => {
      calls.push({ method: "limit", args });
      if (opts?.error) return Promise.resolve({ data: null, error: opts.error });
      const filtered = rows.filter((r) => {
        for (const [col, arr] of overlapFilters) {
          const cell = (r[col] as string[] | undefined) ?? [];
          if (!arr.some((v) => cell.includes(v))) return false;
        }
        for (const [col, val] of eqFilters) {
          if (r[col] !== val) return false;
        }
        return true;
      });
      return Promise.resolve({ data: filtered, error: null });
    };
    return builder;
  };

  const client = {
    from: (table: string) => {
      calls.push({ method: "from", args: [table] });
      return newQuery();
    },
  };
  return { client, calls };
}

const ctx = { tenant_id: "t-1", log: () => {} };

const overlapArgsFor = (
  calls: { method: string; args: unknown[] }[],
  col: string,
): string[][] =>
  calls
    .filter((c) => c.method === "overlaps" && c.args[0] === col)
    .map((c) => c.args[1] as string[]);

beforeEach(() => {
  mocks.serviceClientMock.mockReset();
});

describe("investor_db__search", () => {
  it("queries investor_reference and wires CANONICALIZED sector/stage/geo/leads filters", async () => {
    const { client, calls } = makeFakeClient([]);
    mocks.serviceClientMock.mockReturnValue(client);

    await investorDbSearchTool.execute(ctx, {
      sectors: ["B2B SaaS", "AI"],
      stages: ["Seed"],
      geography: "US/Canada",
      leads_only: true,
    });

    expect(calls.find((c) => c.method === "from")?.args[0]).toBe("investor_reference");
    const overlaps = calls.filter((c) => c.method === "overlaps");
    expect(overlaps).toContainEqual({ method: "overlaps", args: ["niches", ["B2B SaaS", "AI"]] });
    expect(overlaps).toContainEqual({ method: "overlaps", args: ["stages", ["Seed"]] });
    expect(overlaps).toContainEqual({ method: "overlaps", args: ["geographies", ["US/Canada", "USA"]] });
    expect(calls).toContainEqual({ method: "eq", args: ["leads_rounds", true] });
  });

  it("does NOT wire leads/eq when leads_only is absent", async () => {
    const { client, calls } = makeFakeClient([]);
    mocks.serviceClientMock.mockReturnValue(client);
    await investorDbSearchTool.execute(ctx, { sectors: ["FinTech"] });
    expect(calls.find((c) => c.method === "eq")).toBeUndefined();
  });

  it("geography 'US' canonicalizes to US/Canada+USA and returns matching rows", async () => {
    const rows: Row[] = [
      { name: "US fund", geographies: ["US/Canada"], niches: [], stages: [], check_buckets: [], leads_rounds: false },
      { name: "EU fund", geographies: ["Europe"], niches: [], stages: [], check_buckets: [], leads_rounds: false },
    ];
    const { client, calls } = makeFakeClient(rows);
    mocks.serviceClientMock.mockReturnValue(client);

    const out = (await investorDbSearchTool.execute(ctx, { geography: "US" })) as {
      count: number;
      investors: Row[];
    };
    expect(overlapArgsFor(calls, "geographies")).toContainEqual(["US/Canada", "USA"]);
    expect(out.count).toBe(1);
    expect(out.investors[0].name).toBe("US fund");
  });

  it("geography 'United States' also resolves and returns rows", async () => {
    const rows: Row[] = [
      { name: "US fund", geographies: ["US/Canada"], niches: [], stages: [], check_buckets: [], leads_rounds: false },
    ];
    const { client } = makeFakeClient(rows);
    mocks.serviceClientMock.mockReturnValue(client);
    const out = (await investorDbSearchTool.execute(ctx, { geography: "United States" })) as { count: number };
    expect(out.count).toBe(1);
  });

  it("stages ['Pre-Seed'] (capital S) canonicalizes to 'Pre-seed' and returns rows", async () => {
    const rows: Row[] = [
      { name: "Preseed fund", stages: ["Pre-seed"], geographies: [], niches: [], check_buckets: [], leads_rounds: false },
      { name: "Seed fund", stages: ["Seed"], geographies: [], niches: [], check_buckets: [], leads_rounds: false },
    ];
    const { client, calls } = makeFakeClient(rows);
    mocks.serviceClientMock.mockReturnValue(client);

    const out = (await investorDbSearchTool.execute(ctx, { stages: ["Pre-Seed"] })) as {
      count: number;
      investors: Row[];
    };
    expect(overlapArgsFor(calls, "stages")).toContainEqual(["Pre-seed"]);
    expect(out.count).toBe(1);
    expect(out.investors[0].name).toBe("Preseed fund");
  });

  it("stages ['seed'] (lowercase) canonicalizes to 'Seed' and returns rows", async () => {
    const rows: Row[] = [
      { name: "Seed fund", stages: ["Seed"], geographies: [], niches: [], check_buckets: [], leads_rounds: false },
    ];
    const { client, calls } = makeFakeClient(rows);
    mocks.serviceClientMock.mockReturnValue(client);
    const out = (await investorDbSearchTool.execute(ctx, { stages: ["seed"] })) as { count: number };
    expect(overlapArgsFor(calls, "stages")).toContainEqual(["Seed"]);
    expect(out.count).toBe(1);
  });

  it("sector casing is normalized ('b2b saas','fintech' -> 'B2B SaaS','FinTech')", async () => {
    const rows: Row[] = [
      { name: "Fin fund", niches: ["FinTech"], stages: [], geographies: [], check_buckets: [], leads_rounds: false },
    ];
    const { client, calls } = makeFakeClient(rows);
    mocks.serviceClientMock.mockReturnValue(client);
    const out = (await investorDbSearchTool.execute(ctx, { sectors: ["b2b saas", "fintech"] })) as { count: number };
    expect(overlapArgsFor(calls, "niches")).toContainEqual(["B2B SaaS", "FinTech"]);
    expect(out.count).toBe(1);
  });

  it("relaxes geography (only) when the geo-filtered query is empty, and reports it", async () => {
    const rows: Row[] = [
      { name: "AI US fund", niches: ["AI"], geographies: ["US/Canada"], stages: [], check_buckets: [], leads_rounds: false },
    ];
    const { client } = makeFakeClient(rows);
    mocks.serviceClientMock.mockReturnValue(client);

    const out = (await investorDbSearchTool.execute(ctx, { sectors: ["AI"], geography: "India" })) as {
      count: number;
      relaxed_filters?: string[];
      ignored_filters?: string[];
    };
    expect(out.count).toBe(1);
    expect(out.relaxed_filters).toEqual(["geography"]);
    expect(out.ignored_filters).toBeUndefined();
  });

  it("does NOT relax sectors/stages — only geography is ever dropped", async () => {
    const rows: Row[] = [
      { name: "Bio fund", niches: ["BioTech"], geographies: [], stages: [], check_buckets: [], leads_rounds: false },
    ];
    const { client } = makeFakeClient(rows);
    mocks.serviceClientMock.mockReturnValue(client);
    const out = (await investorDbSearchTool.execute(ctx, { sectors: ["AI"] })) as {
      count: number;
      relaxed_filters?: string[];
    };
    expect(out.count).toBe(0);
    expect(out.relaxed_filters).toBeUndefined();
  });

  it("reports unrecognized stage/geography values in ignored_filters", async () => {
    const rows: Row[] = [
      { name: "Preseed fund", stages: ["Pre-seed"], geographies: [], niches: [], check_buckets: [], leads_rounds: false },
    ];
    const { client, calls } = makeFakeClient(rows);
    mocks.serviceClientMock.mockReturnValue(client);

    const out = (await investorDbSearchTool.execute(ctx, {
      stages: ["Pre-Seed", "Series Z"],
      geography: "Atlantis",
    })) as { count: number; ignored_filters?: string[] };

    expect(overlapArgsFor(calls, "stages")).toContainEqual(["Pre-seed"]);
    expect(overlapArgsFor(calls, "geographies")).toHaveLength(0);
    expect(out.ignored_filters).toContain("stage:Series Z");
    expect(out.ignored_filters).toContain("geography:Atlantis");
    expect(out.count).toBe(1);
  });

  it("refines by check_size as a JS substring over check_buckets", async () => {
    const rows: Row[] = [
      { name: "Has 1M", check_buckets: ["$250K - $1M"], niches: [], stages: [], leads_rounds: false },
      { name: "No match", check_buckets: ["$5M - $10M"], niches: [], stages: [], leads_rounds: false },
    ];
    const { client } = makeFakeClient(rows);
    mocks.serviceClientMock.mockReturnValue(client);

    const out = (await investorDbSearchTool.execute(ctx, { check_size: "$1M" })) as {
      investors: Row[];
      count: number;
    };
    expect(out.count).toBe(1);
    expect(out.investors[0].name).toBe("Has 1M");
  });

  it("ranks by niche-overlap count desc against requested sectors", async () => {
    const rows: Row[] = [
      { name: "Two overlap", niches: ["AI", "B2B SaaS"], stages: [], geographies: [], check_buckets: [], leads_rounds: false },
      { name: "One overlap A", niches: ["AI"], stages: [], geographies: [], check_buckets: [], leads_rounds: false },
      { name: "One overlap B", niches: ["B2B SaaS"], stages: [], geographies: [], check_buckets: [], leads_rounds: false },
    ];
    const { client } = makeFakeClient(rows);
    mocks.serviceClientMock.mockReturnValue(client);

    const out = (await investorDbSearchTool.execute(ctx, { sectors: ["AI", "B2B SaaS"] })) as {
      investors: Row[];
    };
    expect(out.investors.map((r) => r.name)).toEqual(["Two overlap", "One overlap A", "One overlap B"]);
  });

  it("clamps limit to the hard cap of 200 and reports truncation", async () => {
    const rows: Row[] = Array.from({ length: 250 }, (_, i) => ({
      name: `inv-${String(i).padStart(3, "0")}`,
      niches: [],
      stages: [],
      geographies: [],
      check_buckets: [],
      leads_rounds: false,
    }));
    const { client } = makeFakeClient(rows);
    mocks.serviceClientMock.mockReturnValue(client);

    const out = (await investorDbSearchTool.execute(ctx, { limit: 9999 })) as {
      investors: Row[];
      truncated: boolean;
    };
    expect(out.investors).toHaveLength(200);
    expect(out.truncated).toBe(true);
  });

  it("returns an ExpectedToolError-shaped failure when the query errors", async () => {
    const { client } = makeFakeClient([], { error: { message: "boom" } });
    mocks.serviceClientMock.mockReturnValue(client);

    await expect(investorDbSearchTool.execute(ctx, {})).rejects.toMatchObject({
      code: "investor_db_query_failed",
    });
  });

  it("Angel round: angel-tagged rows come first, pre-seed funds follow flagged as not angels", async () => {
    const rows: Row[] = [
      { name: "Alpha Fund", niches: ["AI"], stages: ["Pre-seed"], geographies: [], check_buckets: [], leads_rounds: true },
      { name: "Zed Angel", niches: ["AI", "Angel", "and Solo-Capitalists"], stages: ["Seed"], geographies: [], check_buckets: ["$0 - $100K"], leads_rounds: false },
      { name: "Big Partner", niches: ["AI", "Angel"], stages: ["Seed", "Series B+"], geographies: [], check_buckets: ["$3M - $10M"], leads_rounds: true },
      { name: "Growth Fund", niches: ["AI"], stages: ["Series B+"], geographies: [], check_buckets: [], leads_rounds: true },
    ];
    const { client } = makeFakeClient(rows);
    mocks.serviceClientMock.mockReturnValue(client);

    const out = (await investorDbSearchTool.execute(ctx, { sectors: ["AI"], stages: ["Angel"] })) as {
      investors: Array<Row & { angel_tagged: boolean }>;
      ignored_filters?: string[];
    };
    expect(out.ignored_filters).toBeUndefined();
    expect(out.investors.map((i) => [i.name, i.angel_tagged])).toEqual([
      ["Zed Angel", true],
      ["Alpha Fund", false],
      ["Big Partner", false],
    ]);
  });
});
