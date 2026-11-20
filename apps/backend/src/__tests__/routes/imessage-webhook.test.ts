
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => {
  const state = {
    thread: null as { id: string; tenant_id: string; status: string } | null,
    consume: "ok" as string,
    reads: 0,
    enqueued: [] as Record<string, any>[],
    duplicate: false,
    enqueueThrows: false,
    rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
    tenantRpcs: [] as Array<{ tid: string; name: string; args: Record<string, unknown> }>,
    sends: [] as Array<{ handle: string; text: string }>,
    typing: [] as string[],
  };
  const client = {
    from: () => {
      state.reads += 1;
      const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: state.thread }) };
      return b;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcs.push({ name, args });
      return { data: state.consume, error: null };
    },
  };
  return { state, client };
});

vi.mock("@/services/tenant-client", () => ({
  oauthCallbackClient: () => m.client,
  asTenantId: (t: string) => t,
  tenantRpc: async (tid: string, name: string, args: Record<string, unknown>) => {
    m.state.tenantRpcs.push({ tid, name, args });
    return { data: 0, error: null };
  },
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));
vi.mock("@/services/agents/work-queue", () => ({
  ingestAndEnqueueWorkItem: async (i: Record<string, unknown>) => {
    if (m.state.enqueueThrows) throw new Error("fleet halted");
    m.state.enqueued.push(i);
    return { duplicate: m.state.duplicate, ingested_event_id: "ie1", work_item_id: "wi1" };
  },
}));
vi.mock("@/services/connectors/imessage/sendblue", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  sendIMessageText: async (handle: string, text: string) => {
    m.state.sends.push({ handle, text });
    return { ok: true, status: 200 };
  },
  startIMessageTyping: async (handle: string) => {
    m.state.typing.push(handle);
  },
}));

import { imessageWebhook, NOT_CONNECTED_TEXT, PENDING_TEXT } from "@/routes/webhooks/imessage";
import { INTAKE_FAILED_TEXT, MEDIA_UNSUPPORTED_TEXT } from "@/services/connectors/chat-copy";

const SECRET = "hook-secret";
const LINE = "+13475550100";
const TENANT = "22222222-2222-4222-8222-222222222222";
const TOKEN = "abcDEF123456_-xyzabcDEF123456_-x";

function res() {
  const r: any = {
    code: 0,
    body: null as unknown,
    status(c: number) { r.code = c; return r; },
    json(b: unknown) { r.body = b; return r; },
  };
  return r;
}
function req(body: Record<string, unknown>, secret: string = SECRET) {
  return { body, header: (h: string) => (h.toLowerCase() === "sb-signing-secret" ? secret : undefined) } as any;
}
function inbound(content: string, over: Record<string, unknown> = {}) {
  return {
    content,
    is_outbound: false,
    status: "RECEIVED",
    message_handle: "mh-1",
    date_sent: "2026-10-14T12:00:00Z",
    from_number: "+14155550123",
    number: "+14155550123",
    to_number: LINE,
    sendblue_number: LINE,
    message_type: "message",
    group_id: "",
    media_url: "",
    service: "iMessage",
    ...over,
  };
}

const KEYS = ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_SECRET", "SENDBLUE_FROM_NUMBER", "SENDBLUE_WEBHOOK_SECRET"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SENDBLUE_API_KEY_ID = "kid";
  process.env.SENDBLUE_API_SECRET = "ksecret";
  process.env.SENDBLUE_FROM_NUMBER = "+1 (347) 555-0100";
  process.env.SENDBLUE_WEBHOOK_SECRET = SECRET;
  Object.assign(m.state, {
    thread: { id: "th-1", tenant_id: TENANT, status: "enabled" },
    consume: "ok",
    reads: 0,
    enqueued: [],
    duplicate: false,
    enqueueThrows: false,
    rpcs: [],
    tenantRpcs: [],
    sends: [],
    typing: [],
  });
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("the door", () => {
  it("503s and touches nothing while the surface is off", async () => {
    delete process.env.SENDBLUE_WEBHOOK_SECRET;
    const r = res();
    await imessageWebhook(req(inbound("hi")), r);
    expect(r.code).toBe(503);
    expect(m.state.reads + m.state.enqueued.length + m.state.sends.length).toBe(0);
  });

  it("401s a missing or wrong secret and never reaches the DB", async () => {
    for (const secret of ["", "hook-secreT", "hook-secret-longer"]) {
      const r = res();
      await imessageWebhook(req(inbound("hi"), secret), r);
      expect(r.code).toBe(401);
    }
    expect(m.state.reads + m.state.enqueued.length + m.state.rpcs.length).toBe(0);
  });
});

describe("bind (step one of two)", () => {
  it("consumes the token into a PENDING row and texts the code back, queuing nothing", async () => {
    const r = res();
    await imessageWebhook(req(inbound(`Connect Zavi: ${TOKEN}`)), r);
    expect(r.code).toBe(200);
    expect(m.state.rpcs).toHaveLength(1);
    const { name, args } = m.state.rpcs[0]!;
    expect(name).toBe("consume_imessage_link_token");
    expect(args).toMatchObject({ p_token: TOKEN, p_line: LINE, p_handle: "+14155550123" });
    expect(String(args.p_confirm_code)).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(m.state.sends[0]!.text).toContain(String(args.p_confirm_code));
    expect(m.state.enqueued).toHaveLength(0);
  });

  it("refuses a number another workspace owns without naming it", async () => {
    m.state.consume = "owned_by_other_tenant";
    await imessageWebhook(req(inbound(`Connect Zavi: ${TOKEN}`)), res());
    expect(m.state.sends[0]!.text).toBe("This number is already connected to a Zavi workspace.");
  });

  it("lowercases an Apple ID email handle so one person is one binding", async () => {
    await imessageWebhook(req(inbound(`Connect Zavi: ${TOKEN}`, { from_number: "Ann@iCloud.com", number: "Ann@iCloud.com" })), res());
    expect(m.state.rpcs[0]!.args.p_handle).toBe("ann@icloud.com");
  });
});

describe("fails closed", () => {
  it("a pending thread runs nothing and is told to finish connecting", async () => {
    m.state.thread = { id: "th-1", tenant_id: TENANT, status: "pending" };
    await imessageWebhook(req(inbound("what's my revenue?")), res());
    expect(m.state.enqueued).toHaveLength(0);
    expect(m.state.sends).toEqual([{ handle: "+14155550123", text: PENDING_TEXT }]);
  });

  it("an unknown or disconnected sender runs nothing and is told how to connect", async () => {
    for (const thread of [null, { id: "th-1", tenant_id: TENANT, status: "deleted" }]) {
      m.state.thread = thread;
      m.state.sends = [];
      await imessageWebhook(req(inbound("hello?")), res());
      expect(m.state.sends.map((s) => s.text)).toEqual([NOT_CONNECTED_TEXT]);
    }
    expect(m.state.enqueued).toHaveLength(0);
  });

  it("ignores group chats, our own outbound echoes and other lines entirely", async () => {
    for (const over of [
      { group_id: "grp-1", message_type: "group" },
      { is_outbound: true },
      { sendblue_number: "+13475559999", to_number: "+13475559999" },
    ]) {
      const r = res();
      await imessageWebhook(req(inbound("hi", over)), r);
      expect(r.code).toBe(200);
    }
    expect(m.state.enqueued.length + m.state.sends.length + m.state.typing.length).toBe(0);
  });
});

describe("STOP", () => {
  it.each([["STOP", {}], ["hi", { opted_out: true }]])("turns off that one thread and runs nothing (%s)", async (text, over) => {
    await imessageWebhook(req(inbound(text, over)), res());
    expect(m.state.tenantRpcs).toEqual([{ tid: TENANT, name: "unset_imessage_thread", args: { p_thread_id: "th-1" } }]);
    expect(m.state.enqueued.length + m.state.sends.length).toBe(0);
  });

  it("does not treat a sentence that merely contains 'stop' as an opt-out", async () => {
    await imessageWebhook(req(inbound("stop the Meta campaign")), res());
    expect(m.state.tenantRpcs).toHaveLength(0);
    expect(m.state.enqueued).toHaveLength(1);
  });
});

describe("a connected message", () => {
  it("queues the operator with routing, a redacted archive copy and typing dots", async () => {
    await imessageWebhook(req(inbound("how did signups do this week?")), res());
    expect(m.state.enqueued).toHaveLength(1);
    const item = m.state.enqueued[0]!;
    expect(item).toMatchObject({
      tenant_id: TENANT,
      provider: "imessage",
      source: "webhook_imessage",
      agent_slug: "operator",
      external_event_id: "mh-1",
      dedupe_key: "imessage:mh-1",
      payload: {
        imessage: { line: LINE, handle: "+14155550123", message_handle: "mh-1", text: "how did signups do this week?" },
      },
    });
    expect(JSON.stringify(item.ingest_payload)).not.toContain("4155550123");
    expect(m.state.typing).toEqual(["+14155550123"]);
  });

  it("does not re-ack a redelivered message", async () => {
    m.state.duplicate = true;
    await imessageWebhook(req(inbound("again")), res());
    expect(m.state.typing).toHaveLength(0);
  });

  it("answers a photo with no text instead of going silent", async () => {
    await imessageWebhook(req(inbound("", { media_url: "https://cdn.sendblue.co/x.jpg" })), res());
    expect(m.state.enqueued).toHaveLength(0);
    expect(m.state.sends.map((s) => s.text)).toEqual([MEDIA_UNSUPPORTED_TEXT]);
  });

  it("says so when intake fails rather than leaving the person waiting", async () => {
    m.state.enqueueThrows = true;
    const r = res();
    await imessageWebhook(req(inbound("hi")), r);
    expect(r.code).toBe(200);
    expect(m.state.sends.map((s) => s.text)).toEqual([INTAKE_FAILED_TEXT]);
  });
});
