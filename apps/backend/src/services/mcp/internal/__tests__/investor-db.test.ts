
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toAnthropicName, fromAnthropicName } from "../../types";

const mocks = vi.hoisted(() => ({ serviceClientMock: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));

function fakeClient(rows: Record<string, unknown>[]) {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "overlaps", "eq", "order"]) builder[m] = () => builder;
  builder.limit = () => Promise.resolve({ data: rows, error: null });
  return { from: () => builder };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listInvestorDbTools", () => {
  it("advertises investor_db__search with the correct Anthropic name shape", async () => {
    const { listInvestorDbTools } = await import("../investor-db");
    const tools = listInvestorDbTools();
    expect(tools).toHaveLength(1);
    const t = tools[0];
    expect(t.server_id).toBe("investor_db");
    expect(t.tool_name).toBe("search");
    expect(t.input_schema.type).toBe("object");
    const anthropicName = toAnthropicName(t.server_id, t.tool_name);
    expect(anthropicName).toBe("investor_db__search");
    expect(fromAnthropicName(anthropicName)).toEqual({ server_id: "investor_db", tool_name: "search" });
  });
});

describe("callInvestorDbTool", () => {
  it("dispatches search and returns an ok JSON envelope", async () => {
    mocks.serviceClientMock.mockReturnValue(
      fakeClient([{ name: "Acme Partner", niches: ["AI"], stages: ["Seed"], check_buckets: [], leads_rounds: true }]),
    );
    const { callInvestorDbTool } = await import("../investor-db");
    const res = await callInvestorDbTool("t-1", "search", { sectors: ["AI"] });
    expect(res.ok).toBe(true);
    expect(res.is_error).toBe(false);
    const parsed = JSON.parse(res.content) as { count: number; investors: { name: string }[] };
    expect(parsed.count).toBe(1);
    expect(parsed.investors[0].name).toBe("Acme Partner");
  });

  it("returns tool_unknown for an unregistered tool name", async () => {
    const { callInvestorDbTool } = await import("../investor-db");
    const res = await callInvestorDbTool("t-1", "nope", {});
    expect(res.ok).toBe(false);
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toBe("tool_unknown");
  });
});

describe("discovery + execute source wiring", () => {
  const root = join(__dirname, "..", "..");
  it("discovery.ts has the investor_db server row + list branch", () => {
    const src = readFileSync(join(root, "discovery.ts"), "utf8");
    expect(src).toMatch(/server_id:\s*"investor_db"/);
    expect(src).toMatch(/server\.server_id === "investor_db"/);
    expect(src).toMatch(/listInvestorDbTools\(\)/);
  });
  it("execute.ts dispatches investor_db to callInvestorDbTool", () => {
    const src = readFileSync(join(root, "execute.ts"), "utf8");
    expect(src).toMatch(/server_id === "investor_db"/);
    expect(src).toMatch(/callInvestorDbTool\(ctx\.tenant_id,\s*tool_name,\s*args\)/);
  });
});
