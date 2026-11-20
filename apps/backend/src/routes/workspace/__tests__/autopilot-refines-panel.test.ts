import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  conductorList: vi.fn(),
  agentRunsList: vi.fn(),
  eventReads: [] as Array<{ runId: string; kinds: string[] }>,
  eventsFor: new Map<string, { data: unknown[] | null; error: { message: string } | null }>(),
  tenantIds: [] as string[],
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

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: (tenantId: string) => {
    mocks.tenantIds.push(tenantId);
    return {
      from: (table: string) => {
        if (table !== "thread_event") throw new Error(`unexpected tenant table: ${table}`);
        const read = { runId: "", kinds: [] as string[] };
        const chain = {
          select: () => chain,
          eq: (_col: string, value: string) => {
            read.runId = value;
            return chain;
          },
          in: (_col: string, kinds: string[]) => {
            read.kinds = kinds;
            return chain;
          },
          order: () => chain,
          limit: async () => {
            mocks.eventReads.push(read);
            return mocks.eventsFor.get(read.runId) ?? { data: [], error: null };
          },
        };
        return chain;
      },
    };
  },
}));

import { getAutopilotRefines } from "../autopilot";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

function refineRow(id: string, status: string, childRunId: string | null) {
  return {
    id,
    objective: `[refine] ${id}`,
    status,
    goal_graph: [
      { status, child_run_id: childRunId, finished_at: null, payload: { stage: "build", refine_mode: true } },
    ],
    spend_usd: 0,
    max_usd: 5,
    created_at: "2026-09-28T09:00:00Z",
    updated_at: "2026-09-28T09:00:00Z",
  };
}

type Refine = { id: string; status: string; panel: { state: string; summary: string; items: Array<{ type: string; text?: string; label?: string }> } | null };

async function call(): Promise<Refine[]> {
  const res = mockRes();
  await getAutopilotRefines({ query: {} } as never, res as never);
  expect(res.statusCode).toBe(200);
  return (res.body as { refines: Refine[] }).refines;
}

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.conductorList.mockReset();
  mocks.agentRunsList.mockReset();
  mocks.eventReads.length = 0;
  mocks.eventsFor.clear();
  mocks.tenantIds.length = 0;
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-1", user_id: "user-1", access_token: "tok" });
  mocks.agentRunsList.mockResolvedValue({ data: [], error: null });
});

describe("GET refines — live panel for a change still being made", () => {
  it("folds the engineer's newest thread events into a running panel, through the caller's tenant", async () => {
    mocks.conductorList.mockResolvedValueOnce({
      data: [refineRow("cr_live", "active", "ar_live")],
      error: null,
    });
    mocks.eventsFor.set("ar_live", {
      data: [
        { id: 3, kind: "file_edit", body: { path: "src/app/pricing.tsx" } },
        { id: 2, kind: "reasoning", body: { text: "Adding the three rental plans to the landing page." } },
        { id: 1, kind: "reasoning", body: { text: "Reading the current hero." } },
      ],
      error: null,
    });
    const [refine] = await call();
    expect(mocks.tenantIds).toEqual(["tnt-1"]);
    expect(mocks.eventReads).toEqual([{ runId: "ar_live", kinds: expect.arrayContaining(["reasoning", "tool_call", "file_edit"]) }]);
    expect(refine.panel?.state).toBe("running");
    expect(refine.panel?.summary).toBe("Adding the three rental plans to the landing page.");
    const texts = refine.panel!.items.map((i) => i.text ?? i.label);
    expect(texts.indexOf("Reading the current hero.")).toBeLessThan(texts.indexOf("Adding the three rental plans to the landing page."));
    expect(texts.indexOf("Adding the three rental plans to the landing page.")).toBeLessThan(texts.indexOf("Edited code"));
  });

  it("never reads events for a settled change, and a live change without an engineer run has no panel", async () => {
    mocks.conductorList.mockResolvedValueOnce({
      data: [
        refineRow("cr_done", "done", "ar_done"),
        refineRow("cr_failed", "failed", "ar_failed"),
        refineRow("cr_queued", "provisioning", null),
      ],
      error: null,
    });
    mocks.eventsFor.set("ar_done", { data: [{ id: 9, kind: "reasoning", body: { text: "stale" } }], error: null });
    const refines = await call();
    expect(mocks.eventReads).toEqual([]);
    expect(refines.map((r) => [r.id, r.panel])).toEqual([
      ["cr_done", null],
      ["cr_failed", null],
      ["cr_queued", null],
    ]);
  });

  it("keeps the change in the feed when the event read fails or throws", async () => {
    mocks.conductorList.mockResolvedValueOnce({
      data: [refineRow("cr_err", "active", "ar_err"), refineRow("cr_ok", "active", "ar_ok")],
      error: null,
    });
    mocks.eventsFor.set("ar_err", { data: null, error: { message: "permission denied" } });
    mocks.eventsFor.set("ar_ok", { data: [{ id: 1, kind: "reasoning", body: { text: "Still here." } }], error: null });
    const refines = await call();
    expect(refines.find((r) => r.id === "cr_err")?.panel).toBeNull();
    expect(refines.find((r) => r.id === "cr_ok")?.panel?.items.some((i) => i.text === "Still here.")).toBe(true);
  });
});
