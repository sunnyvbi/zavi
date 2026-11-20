
import { describe, it, expect, vi, beforeEach } from "vitest";
import { callPraxisCorpusTool, listPraxisCorpusTools } from "../praxis-corpus";

const mocks = vi.hoisted(() => ({ serviceClientMock: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));

type Row = Record<string, unknown>;

function mkBuilder(
  rows: Row[],
  rec: { eq: Array<[string, unknown]>; neq: Array<[string, unknown]> },
) {
  let orderCol: string | null = null;
  let orderAsc = true;
  const b: Record<string, any> = {
    select: vi.fn(() => b),
    eq: vi.fn((col: string, val: unknown) => {
      rec.eq.push([col, val]);
      return b;
    }),
    neq: vi.fn((col: string, val: unknown) => {
      rec.neq.push([col, val]);
      return b;
    }),
    gte: vi.fn(() => b),
    order: vi.fn((col: string, opts?: { ascending?: boolean }) => {
      orderCol = col;
      orderAsc = opts?.ascending !== false;
      return b;
    }),
    limit: vi.fn(async (n: number) => {
      let out = rows.filter(
        (r) =>
          rec.eq.every(([c, v]) => r[c] === v) &&
          rec.neq.every(([c, v]) => r[c] !== v),
      );
      if (orderCol) {
        const col = orderCol;
        out = out.slice().sort((a, z) => {
          const av = a[col] as string;
          const zv = z[col] as string;
          const cmp = av < zv ? -1 : av > zv ? 1 : 0;
          return orderAsc ? cmp : -cmp;
        });
      }
      return { data: out.slice(0, n), error: null };
    }),
  };
  return b;
}

function mkSvc(rows: Row[], rec: { eq: Array<[string, unknown]>; neq: Array<[string, unknown]> }) {
  const b = mkBuilder(rows, rec);
  mocks.serviceClientMock.mockReturnValue({
    from: vi.fn((table: string) => {
      if (table !== "agent_runs") throw new Error(`unexpected table: ${table}`);
      return b;
    }),
  });
  return b;
}

function parse(res: { content: string }): Record<string, unknown> {
  return JSON.parse(res.content) as Record<string, unknown>;
}

const TENANT_A = "tenant-A";
const TENANT_B = "tenant-B";

const RUN_SEO = "11111111-1111-4111-8111-111111111111";
const RUN_OLD = "22222222-2222-4222-8222-222222222222";
const RUN_NEW = "33333333-3333-4333-8333-333333333333";

function seoRow(over: Partial<Row> = {}): Row {
  return {
    id: RUN_SEO,
    tenant_id: TENANT_A,
    agent_slug: "content-seo",
    status: "success",
    started_at: "2026-06-15T10:00:00Z",
    enqueued_at: "2026-06-15T10:00:00Z",
    output_text: "RAW seo output body",
    parsed: { rendered_markdown: "# Apna Tutor pricing\nReal SEO copy here.", recommendations: [] },
    agent_definition_hash: "abc123",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("read_run_output — tenant isolation (load-bearing)", () => {
  it("returns found:false for a run id owned by ANOTHER tenant (never leaks)", async () => {
    const rec = { eq: [] as Array<[string, unknown]>, neq: [] as Array<[string, unknown]> };
    mkSvc([seoRow({ tenant_id: TENANT_B })], rec);

    const res = await callPraxisCorpusTool(TENANT_A, "read_run_output", { agent_run_id: RUN_SEO });
    expect(res.is_error).toBe(false);
    const out = parse(res);

    expect(rec.eq).toContainEqual(["tenant_id", TENANT_A]);
    expect(out.found).toBe(false);
    expect(out.output_text).toBeUndefined();
  });
});

describe("read_run_output — happy paths", () => {
  it("returns the FULL body (output_text + parsed envelope) for a same-tenant run by id", async () => {
    const rec = { eq: [] as Array<[string, unknown]>, neq: [] as Array<[string, unknown]> };
    mkSvc([seoRow()], rec);

    const res = await callPraxisCorpusTool(TENANT_A, "read_run_output", { agent_run_id: RUN_SEO });
    const out = parse(res);

    expect(out.found).toBe(true);
    expect(out.agent_run_id).toBe(RUN_SEO);
    expect(out.agent_slug).toBe("content-seo");
    expect(out.output_text).toBe("RAW seo output body");
    expect(String(out.parsed)).toContain("Real SEO copy here.");
    expect(out.truncated).toBe(false);
    expect(rec.eq).toContainEqual(["tenant_id", TENANT_A]);
    expect(rec.eq).toContainEqual(["id", RUN_SEO]);
    expect(rec.neq).toContainEqual(["agent_definition_hash", "seed-synthetic"]);
  });

  it("agent_slug fallback returns the MOST-RECENT successful run", async () => {
    const rec = { eq: [] as Array<[string, unknown]>, neq: [] as Array<[string, unknown]> };
    const older = seoRow({ id: RUN_OLD, enqueued_at: "2026-06-10T00:00:00Z", output_text: "OLD" });
    const newer = seoRow({ id: RUN_NEW, enqueued_at: "2026-06-15T00:00:00Z", output_text: "NEW" });
    mkSvc([older, newer], rec);

    const res = await callPraxisCorpusTool(TENANT_A, "read_run_output", { agent_slug: "content-seo" });
    const out = parse(res);

    expect(out.found).toBe(true);
    expect(out.agent_run_id).toBe(RUN_NEW);
    expect(out.output_text).toBe("NEW");
    expect(rec.eq).toContainEqual(["agent_slug", "content-seo"]);
    expect(rec.eq).toContainEqual(["status", "success"]);
  });

  it("omits parsed when include_parsed=false", async () => {
    const rec = { eq: [] as Array<[string, unknown]>, neq: [] as Array<[string, unknown]> };
    mkSvc([seoRow()], rec);

    const res = await callPraxisCorpusTool(TENANT_A, "read_run_output", {
      agent_run_id: RUN_SEO,
      include_parsed: false,
    });
    const out = parse(res);

    expect(out.found).toBe(true);
    expect(out.output_text).toBe("RAW seo output body");
    expect(out.parsed).toBeUndefined();
  });
});

describe("read_run_output — caps + exclusions + input validation", () => {
  it("flags truncated:true when a body exceeds the 64KB cap (stays under enforceResponseCap)", async () => {
    const rec = { eq: [] as Array<[string, unknown]>, neq: [] as Array<[string, unknown]> };
    const huge = "x".repeat(64 * 1024 + 5000);
    mkSvc([seoRow({ output_text: huge, parsed: { rendered_markdown: "small" } })], rec);

    const res = await callPraxisCorpusTool(TENANT_A, "read_run_output", { agent_run_id: RUN_SEO });
    expect(res.is_error).toBe(false);
    const out = parse(res);

    expect(out.truncated).toBe(true);
    expect((out.output_text as string).length).toBeLessThanOrEqual(64 * 1024 + 20);
    expect((out.output_text as string).endsWith("…[truncated]")).toBe(true);
  });

  it("excludes seed-synthetic rows (found:false when the only match is a seed row)", async () => {
    const rec = { eq: [] as Array<[string, unknown]>, neq: [] as Array<[string, unknown]> };
    mkSvc([seoRow({ agent_definition_hash: "seed-synthetic" })], rec);

    const res = await callPraxisCorpusTool(TENANT_A, "read_run_output", { agent_run_id: RUN_SEO });
    const out = parse(res);
    expect(out.found).toBe(false);
  });

  it("accepts a channel slug with an underscore (meta_ads)", async () => {
    const rec = { eq: [] as Array<[string, unknown]>, neq: [] as Array<[string, unknown]> };
    mkSvc([seoRow({ id: RUN_NEW, agent_slug: "meta_ads", output_text: "NEW" })], rec);
    const res = await callPraxisCorpusTool(TENANT_A, "read_run_output", { agent_slug: "meta_ads" });
    expect(parse(res).found).toBe(true);
    expect(rec.eq).toContainEqual(["agent_slug", "meta_ads"]);
  });

  it("errors when neither agent_run_id nor agent_slug is provided", async () => {
    const rec = { eq: [] as Array<[string, unknown]>, neq: [] as Array<[string, unknown]> };
    mkSvc([seoRow()], rec);

    const res = await callPraxisCorpusTool(TENANT_A, "read_run_output", {});
    expect(res.is_error).toBe(true);
    expect(parse(res).error).toBe("tool_input_invalid");
  });
});

describe("read_run_output — discovery", () => {
  it("is advertised by listPraxisCorpusTools as a type:object tool", () => {
    const tools = listPraxisCorpusTools();
    const t = tools.find((x) => x.tool_name === "read_run_output");
    expect(t).toBeTruthy();
    expect(t!.server_id).toBe("praxis_corpus");
    expect(t!.input_schema.type).toBe("object");
  });
});
