
import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueueCalls: Array<Record<string, unknown>> = [];

vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: vi.fn(async (input: Record<string, unknown>) => {
    enqueueCalls.push(input);
    return { run_id: "run-x" };
  }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

let rowAttachments: unknown = null;

function msgRow() {
  return {
    id: "msg-1",
    tenant_id: "t1",
    thread_id: "thr-1",
    from_address: "member@acme.com",
    envelope_to: "upcar@inbox.zaviagent.com",
    subject: "review this",
    body_text: "see attached",
    rfc_message_id: "<abc@x>",
    dedup_key: "dk-1",
    auto_submitted: false,
    attachments: rowAttachments,
  };
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === "email_messages"
              ? { data: msgRow(), error: null }
              : { data: { owner_agent_slug: "operator", owner_identity_id: "id-1" }, error: null },
        }),
      }),
      update: () => {
        const chain: {
          eq: () => typeof chain;
          then: (f: (v: { data: null; error: null }) => unknown) => Promise<unknown>;
        } = { eq: () => chain, then: (f) => Promise.resolve(f({ data: null, error: null })) };
        return chain;
      },
    }),
    rpc: async () => ({ data: "ok", error: null }),
  }),
}));

import { triageOneEmail } from "../email-triage";

describe("triageOneEmail — attachment forwarding", () => {
  beforeEach(() => {
    enqueueCalls.length = 0;
    rowAttachments = null;
  });

  it("stamps attachment_paths ({path,kind:doc}) onto the run when the row has attachments", async () => {
    rowAttachments = [
      { storage_path: "t1/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pdf", filename: "deck.pdf", mime_type: "application/pdf", size_bytes: 1234 },
    ];
    await triageOneEmail("msg-1", "trace");
    expect(enqueueCalls).toHaveLength(1);
    const payload = enqueueCalls[0].payload as { attachment_paths?: unknown; source?: string };
    expect(payload.source).toBe("email");
    expect(payload.attachment_paths).toEqual([
      { path: "t1/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pdf", kind: "doc" },
    ]);
  });

  it("adds NO attachment_paths key when the row has no attachments (byte-identical to before)", async () => {
    rowAttachments = null;
    await triageOneEmail("msg-1", "trace");
    const payload = enqueueCalls[0].payload as Record<string, unknown>;
    expect("attachment_paths" in payload).toBe(false);
  });

  it("filters out malformed attachment rows (missing storage_path)", async () => {
    rowAttachments = [
      { filename: "junk.pdf" },
      { storage_path: "t1/11111111-2222-3333-4444-555555555555.csv" },
    ];
    await triageOneEmail("msg-1", "trace");
    const payload = enqueueCalls[0].payload as { attachment_paths?: Array<{ path: string }> };
    expect(payload.attachment_paths).toEqual([
      { path: "t1/11111111-2222-3333-4444-555555555555.csv", kind: "doc" },
    ]);
  });

  it("keeps trigger='email' (so the dispatcher forwards docs unconditionally)", async () => {
    rowAttachments = [{ storage_path: "t1/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pdf" }];
    await triageOneEmail("msg-1", "trace");
    expect(enqueueCalls[0].trigger).toBe("email");
  });
});
