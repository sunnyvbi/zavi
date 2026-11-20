
import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueueCalls: Array<Record<string, unknown>> = [];

vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: vi.fn(async (input: Record<string, unknown>) => {
    enqueueCalls.push(input);
    return { run_id: "run-x" };
  }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

const msgRow = {
  id: "msg-1",
  tenant_id: "t1",
  thread_id: "thr-1",
  from_address: "sender@example.com",
  envelope_to: "operator@inbox.zaviagent.com",
  subject: "hello",
  body_text: "please help",
  rfc_message_id: "<abc@x>",
  dedup_key: "dk-1",
  auto_submitted: false,
};

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === "email_messages"
              ? { data: msgRow, error: null }
              : { data: { owner_agent_slug: "operator", owner_identity_id: "id-1" }, error: null },
        }),
      }),
      update: () => {
        const chain: { eq: () => typeof chain; then: (f: (v: { data: null; error: null }) => unknown) => Promise<unknown> } = {
          eq: () => chain,
          then: (f) => Promise.resolve(f({ data: null, error: null })),
        };
        return chain;
      },
    }),
    rpc: async () => ({ data: "ok", error: null }),
  }),
}));

import { triageOneEmail } from "../email-triage";

describe("email-triage — inbound-email trust contract", () => {
  beforeEach(() => {
    enqueueCalls.length = 0;
  });

  it("enqueues the operator run with trigger='email' (so untrusted_inbound is set downstream)", async () => {
    await triageOneEmail("msg-1", "trace");
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0].agent_slug).toBe("operator");
    expect(enqueueCalls[0].trigger).toBe("email");
  });
});
