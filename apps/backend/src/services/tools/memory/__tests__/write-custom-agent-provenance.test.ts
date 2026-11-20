
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  resolve: vi.fn(),
  updates: [] as Array<{ tenant: string; patch: unknown; filters: Array<[string, string, unknown]> }>,
}));

vi.mock("@/services/memory/write-path", () => ({ insertProposal: vi.fn() }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
  }),
}));
vi.mock("@/services/agents/custom-agent-writes", () => ({ resolveCustomWriteRun: m.resolve }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tenant: string) => ({
    from: () => ({
      update: (patch: unknown) => {
        const rec = { tenant, patch, filters: [] as Array<[string, string, unknown]> };
        m.updates.push(rec);
        const b = {
          eq: (c: string, v: unknown) => (rec.filters.push(["eq", c, v]), b),
          is: (c: string, v: unknown) => (rec.filters.push(["is", c, v]), b),
          then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
        };
        return b;
      },
    }),
  }),
}));

import { stampCustomAgentProvenance } from "../write";

const admitted = (over: Record<string, unknown> = {}) => ({
  state: "admitted",
  tenant_id: "tenant-a",
  run_id: "run-1",
  agent_id: "agent-1",
  slug: "c-aaaaaaaa01",
  ...over,
});

beforeEach(() => {
  m.resolve.mockReset();
  m.updates.length = 0;
});

describe("stampCustomAgentProvenance", () => {
  it("a verified custom-agent run stamps the agent and run on the note, in its tenant", async () => {
    m.resolve.mockResolvedValue(admitted());
    expect(await stampCustomAgentProvenance("tenant-a", "run-1", "c-aaaaaaaa01", "note-1")).toBe(true);
    expect(m.resolve).toHaveBeenCalledWith("tenant-a", "run-1", "c-aaaaaaaa01");
    expect(m.updates).toHaveLength(1);
    expect(m.updates[0].tenant).toBe("tenant-a");
    expect(m.updates[0].patch).toEqual({ custom_agent_id: "agent-1", run_id: "run-1" });
    expect(m.updates[0].filters).toEqual([
      ["eq", "id", "note-1"],
      ["eq", "source_ref", "run-1"],
      ["is", "custom_agent_id", null],
    ]);
  });

  it("a built-in agent's run (not a custom run) stamps nothing", async () => {
    m.resolve.mockResolvedValue({ state: "not_custom" });
    expect(await stampCustomAgentProvenance("tenant-a", "run-2", "operator", "note-1")).toBe(false);
    expect(m.updates).toHaveLength(0);
  });

  it("a paused/archived agent's run (not admitted) stamps nothing", async () => {
    m.resolve.mockResolvedValue({ ...admitted({ run_id: "run-3" }), state: "blocked", status: "paused" });
    await stampCustomAgentProvenance("tenant-a", "run-3", "c-aaaaaaaa01", "note-1");
    expect(m.updates).toHaveLength(0);
  });

  it("a run resolved to another tenant stamps nothing", async () => {
    m.resolve.mockResolvedValue(admitted({ tenant_id: "tenant-b", run_id: "run-4", agent_id: "agent-b" }));
    await stampCustomAgentProvenance("tenant-a", "run-4", "c-aaaaaaaa01", "note-1");
    expect(m.updates).toHaveLength(0);
  });

  it("a lookup failure is swallowed (the note is already saved)", async () => {
    m.resolve.mockRejectedValue(new Error("db down"));
    expect(await stampCustomAgentProvenance("tenant-a", "run-5", "c-aaaaaaaa01", "note-1")).toBe(false);
  });
});
