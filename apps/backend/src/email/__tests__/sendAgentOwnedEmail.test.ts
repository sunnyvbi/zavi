import { describe, it, expect, vi, beforeEach } from "vitest";

const sends: Array<Record<string, unknown>> = [];
const deletes: Array<{ table: string; col: string; val: unknown }> = [];
let failSend = false;
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let identityRow: Record<string, unknown> | null = null;

vi.mock("@sendgrid/mail", () => ({
  default: {
    setApiKey: vi.fn(),
    send: vi.fn(async (m: Record<string, unknown>) => {
      if (failSend) throw new Error("SendGrid 400");
      sends.push(m);
      return [{ headers: {} }];
    }),
  },
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({
    from: (table: string) => ({
      delete: () => ({
        eq: (col: string, val: unknown) => {
          deletes.push({ table, col, val });
          return Promise.resolve({ error: null });
        },
      }),
      select: () => {
        const q = {
          eq: () => q,
          order: () => q,
          limit: () => q,
          maybeSingle: async () => ({ data: identityRow, error: null }),
        };
        return q;
      },
    }),
  }),
  tenantRpc: vi.fn(async (_t: string, name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    return { data: null, error: null };
  }),
}));

import { sendAgentOwnedEmail } from "../sendAgentOwnedEmail";

const base = {
  tenant_id: "t1",
  agent_slug: "cgo",
  to: "founder@upcar.ai",
  subject: "Your growth brief",
  html: "<p>hi</p>",
  text: "hi",
  fallbackFrom: { email: "hello@zaviagent.com", name: "Zavi" },
};

describe("sendAgentOwnedEmail", () => {
  beforeEach(() => {
    sends.length = 0;
    rpcCalls.length = 0;
    deletes.length = 0;
    failSend = false;
    process.env.SYSTEM_SENDGRID_API_KEY = "k";
    delete process.env.AGENTMAIL_FROM_IDENTITY;
    identityRow = { id: "id-1", reply_to_address: "upcar@inbox.zaviagent.com", from_name: null };
  });

  it("sends From the inbox with our Message-ID and records a thread owned by the agent", async () => {
    const r = await sendAgentOwnedEmail(base);
    expect(r.lane).toBe("inbox");
    expect(sends[0].from).toEqual({ email: "upcar@inbox.zaviagent.com", name: "Zavi" });
    const mid = (sends[0].headers as Record<string, string>)["Message-ID"];
    expect(mid).toMatch(/^<zavi-.+@inbox\.zaviagent\.com>$/);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("ingest_email_message");
    expect(rpcCalls[0].args.p_owner_agent_slug).toBe("cgo");
    expect(rpcCalls[0].args.p_direction).toBe("out");
    expect(rpcCalls[0].args.p_root_message_id).toBe(mid.slice(1, -1).toLowerCase());
    expect(r.message_id).toBe(rpcCalls[0].args.p_root_message_id);
  });

  it("falls back to the caller's From and records nothing when no inbox exists", async () => {
    identityRow = null;
    const r = await sendAgentOwnedEmail(base);
    expect(r.lane).toBe("fallback");
    expect((sends[0].from as { email: string }).email).toBe("hello@zaviagent.com");
    expect(rpcCalls).toHaveLength(0);
  });

  it("AGENTMAIL_FROM_IDENTITY=0 forces the fallback lane", async () => {
    process.env.AGENTMAIL_FROM_IDENTITY = "0";
    const r = await sendAgentOwnedEmail(base);
    expect(r.lane).toBe("fallback");
  });

  it("a subject never carries a line break or control character into the header, on either lane", async () => {
    const subject = "Acme: weekly brief\r\nBcc: victim@example.com\t\u0000done";
    await sendAgentOwnedEmail({ ...base, subject });
    identityRow = null;
    await sendAgentOwnedEmail({ ...base, subject });
    for (const m of sends) expect(m.subject).toBe("Acme: weekly brief Bcc: victim@example.com done");
  });

  it("a failed send removes the recorded thread and still throws", async () => {
    failSend = true;
    await expect(sendAgentOwnedEmail(base)).rejects.toThrow("SendGrid 400");
    expect(rpcCalls).toHaveLength(1);
    expect(deletes).toEqual([
      { table: "email_threads", col: "root_message_id", val: rpcCalls[0].args.p_root_message_id },
    ]);
  });
});
