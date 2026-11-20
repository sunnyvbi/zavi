import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  conductorList: vi.fn(),
  agentRunsList: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      if (table === "conductor_runs") {
        const scoped: Record<string, unknown> = { order: () => ({ limit: mocks.conductorList }) };
        scoped.is = () => scoped;
        return { select: () => ({ eq: () => scoped }) };
      }
      if (table === "agent_runs") {
        return { select: () => ({ eq: () => ({ in: mocks.agentRunsList }) }) };
      }
      throw new Error(`unexpected table in mock: ${table}`);
    },
  }),
  serviceClient: () => ({}),
}));

import { getAutopilotRefines, refinePreviewPath } from "../autopilot";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

function refineRow(id: string, childRunId: string | null) {
  return {
    id,
    objective: `[refine] ${id}`,
    status: "done",
    goal_graph: [
      {
        status: "success",
        child_run_id: childRunId,
        finished_at: null,
        payload: { stage: "build", refine_mode: true, idea: id },
      },
    ],
    spend_usd: 0.5,
    max_usd: 5,
    created_at: "2026-09-29T10:00:00Z",
    updated_at: "2026-09-29T10:00:00Z",
  };
}

const CASES: Array<[string, unknown, string | null]> = [
  ["good", "/laptops", "/laptops"],
  ["protocol_relative", "//evil.com", null],
  ["javascript", "javascript:alert(1)", null],
  ["dot_dot", "../x", null],
  ["absolute", "https://evil.com/laptops", null],
  ["backslash", "/\\evil.com", null],
  ["crlf", "/cart\r\n", null],
  ["number", 42, null],
  ["absent", undefined, null],
];

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.conductorList.mockReset();
  mocks.agentRunsList.mockReset();
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-1", user_id: "user-1", access_token: "tok" });
});

describe("refines feed preview_path", () => {
  it("surfaces the engineer's preview_path only after sanitizing it", async () => {
    mocks.conductorList.mockResolvedValueOnce({
      data: [...CASES.map(([id]) => refineRow(id, `ar_${id}`)), refineRow("no_run", null)],
      error: null,
    });
    mocks.agentRunsList.mockResolvedValueOnce({
      data: CASES.map(([id, raw]) => ({
        id: `ar_${id}`,
        status: "success",
        finished_at: null,
        output_text: null,
        parsed: raw === undefined ? { pr_url: "https://github.com/o/r/pull/1" } : { preview_path: raw },
      })),
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: { limit: "25" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    const rows = (res.body as { refines: Array<{ id: string; preview_path: unknown }> }).refines;
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [id, , expected] of CASES) {
      expect(byId.get(id), id).toBeDefined();
      expect(byId.get(id)!.preview_path, id).toBe(expected);
    }
    expect(byId.get("no_run")!.preview_path).toBeNull();
  });

  it("refinePreviewPath tolerates null and non-object parsed values", () => {
    expect(refinePreviewPath(null)).toBeNull();
    expect(refinePreviewPath("/laptops")).toBeNull();
    expect(refinePreviewPath({ preview_path: " /cart " })).toBe("/cart");
  });
});
