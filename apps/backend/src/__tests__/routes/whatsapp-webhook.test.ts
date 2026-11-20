
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

const m = vi.hoisted(() => {
  const state = {
    thread: null as { tenant_id: string; status: string } | null,
    enqueued: [] as Record<string, unknown>[],
    rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
    sends: [] as Record<string, unknown>[],
    enqueueThrowOn: null as string | null,
  };
  const client = {
    from: () => {
      const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: state.thread }) };
      return b;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcs.push({ name, args });
      if (name === "consume_whatsapp_link_token") return { data: "ok", error: null };
      return { data: null, error: null };
    },
  };
  return { state, client };
});

vi.mock("@/services/tenant-client", () => ({ oauthCallbackClient: () => m.client }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));
vi.mock("@/services/agents/work-queue", () => ({
  ingestAndEnqueueWorkItem: async (i: Record<string, unknown>) => {
    const text = (i as any).payload?.whatsapp?.text;
    if (m.state.enqueueThrowOn && text === m.state.enqueueThrowOn) throw new Error("boom");
    m.state.enqueued.push(i);
    return { duplicate: false, ingested_event_id: "ie1", work_item_id: "wi1" };
  },
}));
vi.mock("@/services/connectors/whatsapp/adapter", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    callWhatsApp: async (to: string, payload: Record<string, unknown>) => {
      m.state.sends.push({ to, payload });
      return { ok: true, status: 200, messageId: "wamid.out" };
    },
  };
});

import { whatsappWebhook, whatsappWebhookVerify } from "@/routes/webhooks/whatsapp";

const SECRET = "app-secret";
const TENANT = "22222222-2222-2222-2222-222222222222";

function res() {
  const r: any = {
    code: 0, body: null as unknown, sent: null as unknown, _type: "",
    status(c: number) { r.code = c; return r; },
    json(b: unknown) { r.body = b; return r; },
    type(t: string) { r._type = t; return r; },
    send(b: unknown) { r.sent = b; return r; },
  };
  return r;
}
function signedReq(body: unknown, secret = SECRET) {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return { body: raw, header: (h: string) => (h.toLowerCase() === "x-hub-signature-256" ? sig : "") } as any;
}
function msg(text: string, id = "wamid.1") {
  return {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "PN1", display_phone_number: "1415" },
      contacts: [{ profile: { name: "R" }, wa_id: "1408" }],
      messages: [{ from: "1408", id, timestamp: "1788300000", type: "text", text: { body: text } }],
    } }] }],
  };
}

const KEYS = ["WHATSAPP_ACCESS_TOKEN","WHATSAPP_PHONE_NUMBER_ID","WHATSAPP_APP_SECRET","WHATSAPP_VERIFY_TOKEN"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {}; for (const k of KEYS) { saved[k] = process.env[k]; }
  process.env.WHATSAPP_ACCESS_TOKEN = "t";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "PN1";
  process.env.WHATSAPP_APP_SECRET = SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";
  m.state.thread = { tenant_id: TENANT, status: "enabled" };
  m.state.enqueued = []; m.state.rpcs = []; m.state.sends = []; m.state.enqueueThrowOn = null;
});
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("SAFE-INERT", () => {
  it("503s and touches nothing when secrets are absent", async () => {
    for (const k of KEYS) delete process.env[k];
    const r = res();
    await whatsappWebhook(signedReq(msg("hi")), r);
    expect(r.code).toBe(503);
    expect(m.state.enqueued).toHaveLength(0);
    expect(m.state.rpcs).toHaveLength(0);
  });
});

describe("signature is the only door", () => {
  it("401s a POST with no signature, and enqueues nothing", async () => {
    const r = res();
    await whatsappWebhook({ body: Buffer.from("{}"), header: () => "" } as any, r);
    expect(r.code).toBe(401);
    expect(m.state.enqueued).toHaveLength(0);
  });

  it("401s a signature computed with the WRONG secret", async () => {
    const r = res();
    await whatsappWebhook(signedReq(msg("hi"), "not-the-secret"), r);
    expect(r.code).toBe(401);
    expect(m.state.enqueued).toHaveLength(0);
  });

  it("401s when the body was tampered after signing", async () => {
    const good = signedReq(msg("hi"));
    good.body = Buffer.from(JSON.stringify(msg("evil")));
    const r = res();
    await whatsappWebhook(good, r);
    expect(r.code).toBe(401);
    expect(m.state.enqueued).toHaveLength(0);
  });
});

describe("GET handshake", () => {
  it("echoes hub.challenge as PLAINTEXT on a token match", async () => {
    const r = res();
    await whatsappWebhookVerify({ query: { "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "12345" } } as any, r);
    expect(r.code).toBe(200);
    expect(r.sent).toBe("12345");
    expect(r._type).toBe("text/plain");
  });

  it("403s a wrong token and does NOT echo the challenge", async () => {
    const r = res();
    await whatsappWebhookVerify({ query: { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "12345" } } as any, r);
    expect(r.code).toBe(403);
    expect(r.sent).toBeNull();
  });
});

describe("fail-closed routing", () => {
  it("routes an enabled thread to its tenant", async () => {
    await whatsappWebhook(signedReq(msg("what is my spend?")), res());
    expect(m.state.enqueued).toHaveLength(1);
    expect(m.state.enqueued[0]).toMatchObject({ tenant_id: TENANT, source: "webhook_whatsapp", agent_slug: "operator" });
  });

  it("acks new work with an ⏳ reaction on the customer's message, not a text bubble", async () => {
    await whatsappWebhook(signedReq(msg("what is my spend?", "wamid.ack")), res());
    expect(m.state.sends).toHaveLength(1);
    expect(m.state.sends[0]).toMatchObject({
      to: "1408",
      payload: { type: "reaction", reaction: { message_id: "wamid.ack", emoji: "⏳" } },
    });
    expect(JSON.stringify(m.state.sends)).not.toContain("On it");
  });

  it("IGNORES a pending thread — this is what makes the two-step bind a real gate", async () => {
    m.state.thread = { tenant_id: TENANT, status: "pending" };
    await whatsappWebhook(signedReq(msg("what is my spend?")), res());
    expect(m.state.enqueued).toHaveLength(0);
  });

  it("ignores an unbound thread", async () => {
    m.state.thread = null;
    await whatsappWebhook(signedReq(msg("hello")), res());
    expect(m.state.enqueued).toHaveLength(0);
  });

  it("runs the CAPTION as the task when an image carries one (Telegram parity)", async () => {
    const body = msg("x");
    (body.entry[0].changes[0].value.messages[0] as any) = {
      from: "1408", id: "wamid.cap", timestamp: "1788300000", type: "image",
      image: { id: "media1", mime_type: "image/jpeg", caption: "what's wrong with this listing?" },
    };
    await whatsappWebhook(signedReq(body), res());
    expect(m.state.enqueued).toHaveLength(1);
    expect((m.state.enqueued[0] as any).payload.whatsapp.text).toBe("what's wrong with this listing?");
    expect(JSON.stringify(m.state.sends)).not.toContain("can't read images");
  });

  it("answers media instead of running an agent on an unreadable message", async () => {
    const body = msg("x");
    (body.entry[0].changes[0].value.messages[0] as any) = {
      from: "1408", id: "wamid.img", timestamp: "1788300000", type: "image", image: { id: "media1" },
    };
    await whatsappWebhook(signedReq(body), res());
    expect(m.state.enqueued).toHaveLength(0);
    expect(JSON.stringify(m.state.sends)).toContain("can't read images");
  });
});

describe("batching", () => {
  it("processes EVERY message in a batched delivery", async () => {
    const body = msg("first");
    body.entry[0].changes[0].value.messages.push(
      { from: "1408", id: "wamid.2", timestamp: "1788300001", type: "text", text: { body: "second" } } as any,
    );
    await whatsappWebhook(signedReq(body), res());
    expect(m.state.enqueued).toHaveLength(2);
  });

  it("isolates a poisoned item so the rest of the batch still lands", async () => {
    m.state.enqueueThrowOn = "poison";
    const body = msg("poison");
    body.entry[0].changes[0].value.messages.push(
      { from: "1408", id: "wamid.2", timestamp: "1788300001", type: "text", text: { body: "good" } } as any,
    );
    const r = res();
    await whatsappWebhook(signedReq(body), r);
    expect(r.code).toBe(200);
    expect(m.state.enqueued).toHaveLength(1);
    expect((m.state.enqueued[0] as any).payload.whatsapp.text).toBe("good");
  });
});
