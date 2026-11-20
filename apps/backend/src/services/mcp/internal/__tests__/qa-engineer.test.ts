import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSingle = vi.fn();
const mockInsert = vi.fn(() => ({
  select: vi.fn(() => ({ single: mockSingle })),
}));
const mockCountEq = vi.fn();
const mockCountSelect = vi.fn(() => ({ eq: mockCountEq }));
const mockFrom = vi.fn((table: string) => {
  if (table === "test_cases")
    return { insert: mockInsert, select: mockCountSelect };
  throw new Error(`unexpected table ${table}`);
});

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: mockFrom }),
}));

import {
  qaAddTestCase,
  qaCountTestCases,
  listQaEngineerTools,
  callQaEngineerTool,
} from "../qa-engineer";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listQaEngineerTools", () => {
  it("advertises the 5 qa_engineer tools (3 read + 2 write), all object-schema'd", () => {
    const tools = listQaEngineerTools();
    expect(tools).toHaveLength(5);
    for (const t of tools) {
      expect(t.server_id).toBe("qa_engineer");
      expect(t.input_schema.type).toBe("object");
    }
    const names = tools.map((t) => t.tool_name).sort();
    expect(names).toEqual(
      [
        "add_test_case",
        "count_test_cases",
        "get_runtime_config",
        "list_active_tests",
        "record_test_outcome",
      ].sort(),
    );
  });
});

describe("count_test_cases", () => {
  it("returns total + by_status + by_role", async () => {
    mockCountEq.mockResolvedValueOnce({
      data: [
        { status: "active", role: "guest" },
        { status: "muted", role: "host" },
        { status: "archived", role: "public" },
        { status: "active", role: "guest" },
      ],
      error: null,
    });
    const counts = await qaCountTestCases({
      tenant_id: "tnt-abc",
      run_id: "r-1",
      agent_slug: "qa",
    });
    expect(counts).toEqual({
      count: 4,
      by_status: { active: 2, muted: 1, archived: 1 },
      by_role: { guest: 2, host: 1, public: 1 },
    });
  });

  it("is tenant-scoped (queries .eq tenant_id from ctx)", async () => {
    mockCountEq.mockResolvedValueOnce({ data: [], error: null });
    await qaCountTestCases({
      tenant_id: "tnt-xyz",
      run_id: "r-1",
      agent_slug: "qa",
    });
    expect(mockCountSelect).toHaveBeenCalledWith("status, role");
    expect(mockCountEq).toHaveBeenCalledWith("tenant_id", "tnt-xyz");
  });

  it("rejects a non-qa caller", async () => {
    await expect(
      qaCountTestCases({ tenant_id: "tnt-1", run_id: "r-2", agent_slug: "pm" }),
    ).rejects.toThrow(/belongs to agent pm/);
    expect(mockCountSelect).not.toHaveBeenCalled();
  });

  it("dispatches through callQaEngineerTool", async () => {
    mockCountEq.mockResolvedValueOnce({
      data: [{ status: "active", role: "guest" }],
      error: null,
    });
    const r = await callQaEngineerTool(
      { tenant_id: "tnt-1", run_id: "r-1", agent_slug: "qa" },
      "count_test_cases",
      {},
    );
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content)).toEqual({
      count: 1,
      by_status: { active: 1, muted: 0, archived: 0 },
      by_role: { guest: 1, host: 0, public: 0 },
    });
  });
});

describe("callQaEngineerTool — dispatch", () => {
  it("returns is_error:true for unknown tool", async () => {
    const r = await callQaEngineerTool(
      { tenant_id: "tnt-1", run_id: "r-1", agent_slug: "qa" },
      "no_such_tool",
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.is_error).toBe(true);
    expect(JSON.parse(r.content).error).toBe("tool_unknown");
  });

  it("returns is_error:true for invalid args (empty steps)", async () => {
    const r = await callQaEngineerTool(
      { tenant_id: "tnt-1", run_id: "r-1", agent_slug: "qa" },
      "add_test_case",
      {
        title: "Login as guest",
        role: "guest",
        nl_spec: { steps: [], expected_outcome: "logged in", preconditions: [] },
        created_by: "operator-chat",
      },
    );
    expect(r.ok).toBe(false);
    expect(r.is_error).toBe(true);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns is_error:true for unknown role", async () => {
    const r = await callQaEngineerTool(
      { tenant_id: "tnt-1", run_id: "r-1", agent_slug: "qa" },
      "add_test_case",
      {
        title: "Login",
        role: "admin",
        nl_spec: { steps: ["x"], expected_outcome: "y", preconditions: [] },
        created_by: "operator-chat",
      },
    );
    expect(r.ok).toBe(false);
    expect(r.is_error).toBe(true);
  });

  it("accepts minimal valid args and returns the new id in McpCallResult shape", async () => {
    mockSingle.mockResolvedValueOnce({ data: { id: "case-1" }, error: null });
    const r = await callQaEngineerTool(
      { tenant_id: "tnt-abc", run_id: "r-1", agent_slug: "qa" },
      "add_test_case",
      {
        title: "Search results render",
        role: "guest",
        nl_spec: {
          steps: ["go to /search"],
          expected_outcome: "results visible",
          preconditions: [],
        },
        tags: [],
        created_by: "operator-chat",
      },
    );
    expect(r.ok).toBe(true);
    expect(r.is_error).toBe(false);
    expect(typeof r.ms).toBe("number");
    expect(JSON.parse(r.content)).toEqual({ id: "case-1" });
  });
});

describe("qaAddTestCase — Codex C8 boundary", () => {
  it("inserts with the ctx.tenant_id (not anything from args)", async () => {
    mockSingle.mockResolvedValueOnce({ data: { id: "case-1" }, error: null });
    await qaAddTestCase(
      { tenant_id: "tnt-abc", run_id: "r-1", agent_slug: "qa" },
      {
        title: "x",
        role: "guest",
        nl_spec: { steps: ["a"], expected_outcome: "b", preconditions: [] },
        tags: [],
        created_by: "operator-chat",
      },
    );
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: "tnt-abc", title: "x" }),
    );
  });

  it("rejects when ctx.agent_slug is not qa", async () => {
    await expect(
      qaAddTestCase(
        { tenant_id: "tnt-abc", run_id: "r-2", agent_slug: "engineer" },
        {
          title: "x",
          role: "public",
          nl_spec: { steps: ["a"], expected_outcome: "b", preconditions: [] },
          tags: [],
          created_by: "operator-chat",
        },
      ),
    ).rejects.toThrow(/belongs to agent engineer/);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("fail-closed when ctx.agent_slug is undefined", async () => {
    await expect(
      qaAddTestCase(
        { tenant_id: "tnt-x", run_id: "r-4" } as {
          tenant_id: string;
          run_id: string;
          agent_slug?: string;
        },
        {
          title: "x",
          role: "public",
          nl_spec: { steps: ["a"], expected_outcome: "b", preconditions: [] },
          tags: [],
          created_by: "operator-chat",
        },
      ),
    ).rejects.toThrow(/<missing>/);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("surfaces DB insert errors cleanly", async () => {
    mockSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "RLS denied" },
    });
    await expect(
      qaAddTestCase(
        { tenant_id: "tnt-1", run_id: "r-3", agent_slug: "qa" },
        {
          title: "x",
          role: "guest",
          nl_spec: { steps: ["a"], expected_outcome: "b", preconditions: [] },
          tags: [],
          created_by: "operator-chat",
        },
      ),
    ).rejects.toThrow(/insert failed.*RLS denied/);
  });
});
