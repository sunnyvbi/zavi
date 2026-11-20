
import { describe, it, expect, vi, beforeEach } from "vitest";

let captured: {
  table?: string;
  select?: string;
  eq: Array<[string, unknown]>;
  in: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
  orderCol?: string;
  orderAsc?: boolean;
  limit?: number;
};

let mockResolve: { data: unknown; error: unknown } = { data: [], error: null };

function newQuery() {
  const q: Record<string, unknown> = {};
  q.select = vi.fn((s: string) => {
    captured.select = s;
    return q;
  });
  q.eq = vi.fn((k: string, v: unknown) => {
    captured.eq.push([k, v]);
    return q;
  });
  q.in = vi.fn((k: string, v: unknown) => {
    captured.in.push([k, v]);
    return q;
  });
  q.is = vi.fn((k: string, v: unknown) => {
    captured.is.push([k, v]);
    return q;
  });
  q.order = vi.fn((col: string, opts?: { ascending?: boolean }) => {
    captured.orderCol = col;
    captured.orderAsc = opts?.ascending ?? true;
    return q;
  });
  q.limit = vi.fn((n: number) => {
    captured.limit = n;
    return Promise.resolve(mockResolve);
  });
  return q;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({
    from: vi.fn((name: string) => {
      captured.table = name;
      return newQuery();
    }),
  })),
}));

const TENANT = "11111111-1111-1111-1111-111111111111";
const AGENT = "operator";

beforeEach(() => {
  captured = { eq: [], in: [], is: [] };
  mockResolve = { data: [], error: null };
});

describe("loadAgentEpisodic — query shape", () => {
  it("issues filter on (tenant_id, agent_slug, note_type IN [private types]), non-superseded, order by created_at DESC", async () => {
    const { loadAgentEpisodic } = await import("../../memory/loader");
    await loadAgentEpisodic(TENANT, AGENT);
    expect(captured.table).toBe("memory_note");
    expect(captured.eq).toEqual(
      expect.arrayContaining([
        ["tenant_id", TENANT],
        ["agent_slug", AGENT],
      ]),
    );
    expect(captured.in).toEqual([
      ["note_type", ["agent_experience", "agent_procedural"]],
    ]);
    expect(captured.is).toEqual([
      ["superseded_by", null],
      ["archived_at", null],
    ]);
    expect(captured.orderCol).toBe("created_at");
    expect(captured.orderAsc).toBe(false);
  });

  it("default limit is 20", async () => {
    const { loadAgentEpisodic } = await import("../../memory/loader");
    await loadAgentEpisodic(TENANT, AGENT);
    expect(captured.limit).toBe(20);
  });

  it("clamps limit to >= 1 (floor protects against 0/negative)", async () => {
    const { loadAgentEpisodic } = await import("../../memory/loader");
    await loadAgentEpisodic(TENANT, AGENT, 0);
    expect(captured.limit).toBe(1);
    captured = { eq: [], in: [], is: [] };
    await loadAgentEpisodic(TENANT, AGENT, -5);
    expect(captured.limit).toBe(1);
  });

  it("clamps limit to <= 100 (ceiling protects against runaway pulls)", async () => {
    const { loadAgentEpisodic } = await import("../../memory/loader");
    await loadAgentEpisodic(TENANT, AGENT, 999);
    expect(captured.limit).toBe(100);
  });

  it("floors fractional limits", async () => {
    const { loadAgentEpisodic } = await import("../../memory/loader");
    await loadAgentEpisodic(TENANT, AGENT, 25.7);
    expect(captured.limit).toBe(25);
  });
});

describe("loadAgentEpisodic — return shape", () => {
  it("empty data returns empty string", async () => {
    mockResolve = { data: [], error: null };
    const { loadAgentEpisodic } = await import("../../memory/loader");
    expect(await loadAgentEpisodic(TENANT, AGENT)).toBe("");
  });

  it("null data also returns empty string", async () => {
    mockResolve = { data: null, error: null };
    const { loadAgentEpisodic } = await import("../../memory/loader");
    expect(await loadAgentEpisodic(TENANT, AGENT)).toBe("");
  });

  it("formats rows as `### N. title — ts` heading + body", async () => {
    mockResolve = {
      data: [
        {
          title: "campaign-abc paused after CTR drop",
          body_markdown: "Paused 2026-05-25 after CTR dropped 4.1→1.2%. Resumed 2026-05-26 with new creative.",
          created_at: "2026-05-26T00:00:00Z",
        },
        {
          title: "lead-routing rule for Tier-1 cities",
          body_markdown: "Established cohort routing for SF/NYC. Conversion +18%.",
          created_at: "2026-05-20T12:00:00Z",
        },
      ],
      error: null,
    };
    const { loadAgentEpisodic } = await import("../../memory/loader");
    const out = await loadAgentEpisodic(TENANT, AGENT);
    expect(out).toContain("### 1. campaign-abc paused after CTR drop");
    expect(out).toContain("2026-05-26T00:00:00Z");
    expect(out).toContain("Paused 2026-05-25 after CTR dropped 4.1→1.2%");
    expect(out).toContain("### 2. lead-routing rule for Tier-1 cities");
    expect(out).toMatch(/Paused 2026-05-25[^\n]*\n\n### 2\./);
  });

  it("falls back to '(untitled)' on null/empty title", async () => {
    mockResolve = {
      data: [
        { title: null, body_markdown: "body content", created_at: "2026-05-26T00:00:00Z" },
      ],
      error: null,
    };
    const { loadAgentEpisodic } = await import("../../memory/loader");
    const out = await loadAgentEpisodic(TENANT, AGENT);
    expect(out).toContain("### 1. (untitled)");
  });
});

describe("loadAgentEpisodic — validation + errors", () => {
  it("rejects malformed tenant_id", async () => {
    const { loadAgentEpisodic, InvalidSlugError } = await import("../../memory/loader");
    await expect(loadAgentEpisodic("not-a-uuid", AGENT)).rejects.toBeInstanceOf(InvalidSlugError);
  });

  it("rejects malformed agent_slug (uppercase, special chars)", async () => {
    const { loadAgentEpisodic, InvalidSlugError } = await import("../../memory/loader");
    await expect(loadAgentEpisodic(TENANT, "Operator!")).rejects.toBeInstanceOf(InvalidSlugError);
    await expect(loadAgentEpisodic(TENANT, "OPERATOR")).rejects.toBeInstanceOf(InvalidSlugError);
    await expect(loadAgentEpisodic(TENANT, "")).rejects.toBeInstanceOf(InvalidSlugError);
  });

  it("throws on DB error so dispatcher can log + degrade", async () => {
    mockResolve = { data: null, error: { message: "boom" } };
    const { loadAgentEpisodic } = await import("../../memory/loader");
    await expect(loadAgentEpisodic(TENANT, AGENT)).rejects.toThrow(/agent_experience read failed/);
  });
});
