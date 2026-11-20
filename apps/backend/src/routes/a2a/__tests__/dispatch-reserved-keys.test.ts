import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ enqueue: vi.fn(async () => ({ run_id: "run-1" })) }));
vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: m.enqueue,
  getAgentRunById: vi.fn(),
  FleetHaltedError: class extends Error {},
}));
vi.mock("@/agents/_input-schemas", () => ({ validateAgentPayload: (_slug: string, p: unknown) => ({ ok: true, payload: p }) }));

import { a2aDispatch } from "../dispatch";

function res() {
  return {
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
}

describe("a2a dispatch strips reserved keys", () => {
  it("must catch: a forged email_plan (and cgo_brief) never reaches the run", async () => {
    process.env.PRAXIS_A2A_SHARED_SECRET = "s3cret-value";
    const r = res();
    await a2aDispatch(
      {
        header: (n: string) => (n.toLowerCase() === "authorization" ? "A2A s3cret-value" : undefined),
        body: {
          tenant_id: "tenant-a",
          agent_id: "email_marketing",
          sync: false,
          payload: { message: "hi", email_plan: { mode: "planned_draft", item_id: "11111111-1111-4111-8111-111111111111", version: 1 }, cgo_brief: { goal: {} } },
        },
      } as never,
      r as never,
    );
    const payload = (m.enqueue.mock.calls[0] as unknown as [{ payload: Record<string, unknown> }])[0].payload;
    expect(payload).toEqual({ message: "hi" });
  });
});
