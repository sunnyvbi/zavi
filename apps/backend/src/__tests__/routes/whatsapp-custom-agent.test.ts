import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

const m = vi.hoisted(() => ({
  state: {
    thread: { tenant_id: "22222222-2222-2222-2222-222222222222", status: "enabled" },
    enqueued: [] as Record<string, any>[],
    sends: [] as Record<string, any>[],
  },
  resolve: vi.fn(),
  owner: vi.fn(),
  run: vi.fn(),
  free: vi.fn(),
  issued: vi.fn(async () => true),
}));

vi.mock("@/services/tenant-client", () => ({
  oauthCallbackClient: () => ({
    from: () => {
      const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: m.state.thread }) };
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));
vi.mock("@/services/agents/custom-agent-runs", () => ({ flushCustomAgentWhatsAppPending: async () => {} }));
vi.mock("@/services/agents/work-queue", () => ({
  ingestAndEnqueueWorkItem: async (i: Record<string, unknown>) => {
    m.state.enqueued.push(i);
    return { duplicate: false, ingested_event_id: "ie1", work_item_id: "wi1" };
  },
}));
vi.mock("@/services/connectors/whatsapp/adapter", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  callWhatsApp: async (to: string, payload: Record<string, unknown>) => {
    m.state.sends.push({ to, payload });
    return { ok: true, status: 200, messageId: "wamid.out" };
  },
}));
vi.mock("@/services/agents/custom-agent-chat", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  resolveCustomAgentMention: m.resolve,
  whatsappOwnerUserId: m.owner,
  runCustomAgentConfirm: m.run,
  tenantIsFree: m.free,
  confirmCodeIssued: m.issued,
}));

import { whatsappWebhook } from "@/routes/webhooks/whatsapp";

const SECRET = "app-secret";
const TENANT = "22222222-2222-2222-2222-222222222222";
const KEYS = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"];
let saved: Record<string, string | undefined> = {};

function signed(message: Record<string, unknown>) {
  const body = {
    entry: [{ changes: [{ value: { metadata: { phone_number_id: "PN1" }, contacts: [], messages: [{ from: "1408", id: "wamid.1", timestamp: "1788300000", ...message }] } }] }],
  };
  const raw = Buffer.from(JSON.stringify(body));
  const sig = "sha256=" + crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
  return { body: raw, header: (h: string) => (h.toLowerCase() === "x-hub-signature-256" ? sig : "") } as any;
}
const res = () => {
  const r: any = { status: () => r, json: () => r };
  return r;
};
const texts = () => m.state.sends.filter((s) => s.payload.type === "text").map((s) => s.payload.text.body);

beforeEach(() => {
  saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.WHATSAPP_ACCESS_TOKEN = "t";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "PN1";
  process.env.WHATSAPP_APP_SECRET = SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = "v";
  m.state.enqueued = [];
  m.state.sends = [];
  for (const f of [m.resolve, m.owner, m.run, m.free]) f.mockReset();
  m.resolve.mockResolvedValue(null);
  m.free.mockResolvedValue(false);
});
afterEach(() => {
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
});

describe("WhatsApp @name", () => {
  it("routes an active custom agent of the resolved tenant, with WhatsApp routing", async () => {
    m.resolve.mockResolvedValue({ kind: "run", agent: { id: "ag", slug: "c-aaaaaaaa01", name: "Standup", status: "active" }, task: "go" });
    await whatsappWebhook(signed({ type: "text", text: { body: "@Standup go" } }), res());
    expect(m.resolve).toHaveBeenCalledWith(TENANT, "@Standup go");
    expect(m.state.enqueued).toHaveLength(1);
    expect(m.state.enqueued[0]).toMatchObject({
      tenant_id: TENANT,
      agent_slug: "c-aaaaaaaa01",
      source: "webhook_whatsapp",
      payload: { task_description: "go", whatsapp: { wa_id: "1408", phone_number_id: "PN1" } },
    });
  });

  it("no match: the operator gets it, unchanged", async () => {
    await whatsappWebhook(signed({ type: "text", text: { body: "hello there" } }), res());
    expect(m.state.enqueued[0]).toMatchObject({ agent_slug: "operator" });
  });

  it("paused agent: plain reply, no run", async () => {
    m.resolve.mockResolvedValue({ kind: "paused", agent: { id: "ag", slug: "c-aaaaaaaa01", name: "Standup", status: "paused" } });
    await whatsappWebhook(signed({ type: "text", text: { body: "@Standup go" } }), res());
    expect(m.state.enqueued).toHaveLength(0);
    expect(texts()).toEqual(["Standup is paused. Resume it on its Agent Builder page."]);
  });

  it("Free tenant: the typed refusal, no run", async () => {
    m.resolve.mockResolvedValue({ kind: "run", agent: { id: "ag", slug: "c-aaaaaaaa01", name: "Standup", status: "active" }, task: "" });
    m.free.mockResolvedValue(true);
    await whatsappWebhook(signed({ type: "text", text: { body: "@Standup" } }), res());
    expect(m.state.enqueued).toHaveLength(0);
    expect(texts()[0]).toMatch(/^Custom agents are available on paid plans\. Upgrade here: /);
  });
});

describe("WhatsApp @name, plan unreadable", () => {
  it("refuses plainly and queues nothing", async () => {
    m.resolve.mockResolvedValue({ kind: "run", agent: { id: "ag", slug: "c-aaaaaaaa01", name: "Standup", status: "active" }, task: "go" });
    m.free.mockResolvedValue(null);
    await whatsappWebhook(signed({ type: "text", text: { body: "@Standup go" } }), res());
    expect(m.state.enqueued).toHaveLength(0);
    expect(texts()).toEqual(["Something went wrong. Please try again."]);
  });
});

describe("WhatsApp CONFIRM", () => {
  it("a non-owner number is refused, nothing consumed", async () => {
    m.owner.mockResolvedValue(null);
    await whatsappWebhook(signed({ type: "text", text: { body: "CONFIRM ABCD2345" } }), res());
    expect(m.run).not.toHaveBeenCalled();
    expect(texts()).toEqual([
      "Only the workspace owner's verified number can create agents on WhatsApp. Ask your owner, or create it in Zavi or Slack.",
    ]);
    expect(m.state.enqueued).toHaveLength(0);
  });

  it("the owner's button reply consumes with the hash and creates as the owner", async () => {
    m.owner.mockResolvedValue("u-owner");
    m.run.mockResolvedValue({ ok: true, text: "Agent created. Open it in Agent Builder: x" });
    const hash = "b".repeat(64);
    await whatsappWebhook(
      signed({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: `cac:ABCD2345:${hash}`, title: "Confirm" } } }),
      res(),
    );
    expect(m.run).toHaveBeenCalledWith(
      TENANT,
      { code: "ABCD2345", surface: "whatsapp", external_user_id: "1408", phone_number_id: "PN1", draft_hash: hash },
      { created_by: "u-owner", slack_user_id: null },
    );
    expect(texts()).toEqual(["Agent created. Open it in Agent Builder: x"]);
  });

  it("typed 'confirm <word>' that matches no issued code is an ordinary message for Zavi", async () => {
    m.owner.mockResolvedValue("u-owner");
    m.issued.mockResolvedValueOnce(false);
    m.resolve.mockResolvedValue(null);
    await whatsappWebhook(signed({ type: "text", text: { body: "confirm feedback" } }), res());
    expect(m.run).not.toHaveBeenCalled();
    expect(texts()).toEqual([]);
    expect(m.state.enqueued[0]).toMatchObject({ agent_slug: "operator" });
  });

  it("an expired code says so", async () => {
    m.owner.mockResolvedValue("u-owner");
    m.run.mockResolvedValue({ ok: false, text: "This confirm has expired. Ask Zavi to draft the agent again." });
    await whatsappWebhook(signed({ type: "text", text: { body: "confirm abcd2345" } }), res());
    expect(texts()).toEqual(["This confirm has expired. Ask Zavi to draft the agent again."]);
  });
});
