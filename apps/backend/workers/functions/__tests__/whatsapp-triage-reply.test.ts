
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => {
  const state = {
    run: null as Record<string, unknown> | null,
    binding: null as { tenant_id: string; window_expires_at: string | null } | null,
    send: { ok: true, chunks: 1 } as Record<string, unknown>,
    template: { ok: true, chunks: 1, templateFallback: true } as Record<string, unknown>,
    claimError: null as { message: string } | null,
    goneUpdateFilters: [] as Array<[string, unknown]>,
    claimDeletes: 0,
    sendCalls: [] as Record<string, unknown>[],
    templateCalls: [] as Record<string, unknown>[],
    logs: [] as Record<string, unknown>[],
  };

  const from = vi.fn((table: string) => {
    if (table === "agent_runs") {
      const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: state.run }) };
      return b;
    }
    if (table === "whatsapp_threads") {
      const b: any = {
        select: () => b,
        eq: (k: string, v: unknown) => {
          b.__update && state.goneUpdateFilters.push([k, v]);
          return b;
        },
        maybeSingle: async () => ({ data: state.binding }),
        update: () => {
          b.__update = true;
          return b;
        },
      };
      return b;
    }
    if (table === "whatsapp_reply_claims") {
      const b: any = {
        insert: async () => ({ error: state.claimError }),
        delete: () => ({ eq: async () => { state.claimDeletes += 1; return { error: null }; } }),
      };
      return b;
    }
    throw new Error(`unexpected table ${table}`);
  });

  return { state, from };
});

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: m.from }) }));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: async (e: Record<string, unknown>) => { m.state.logs.push(e); },
}));
vi.mock("@/services/tools/whatsapp/_client", () => ({
  postWhatsAppReply: async (a: Record<string, unknown>) => { m.state.sendCalls.push(a); return m.state.send; },
  postWhatsAppWindowTemplate: async (a: Record<string, unknown>) => { m.state.templateCalls.push(a); return m.state.template; },
}));

import { replyOne } from "../whatsapp-triage-reply";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OPEN = new Date(Date.now() + 6 * 3600_000).toISOString();

function baseRun(over: Record<string, unknown> = {}) {
  return {
    tenant_id: TENANT,
    trigger: "whatsapp",
    status: "success",
    output_text: "here is your ad spend breakdown",
    agent_slug: "operator",
    payload: { whatsapp: { wa_id: "14085551234", phone_number_id: "PN1", message_id: "wamid.X" } },
    ...over,
  };
}

beforeEach(() => {
  m.state.run = baseRun();
  m.state.binding = { tenant_id: TENANT, window_expires_at: OPEN };
  m.state.send = { ok: true, chunks: 1 };
  m.state.template = { ok: true, chunks: 1, templateFallback: true };
  m.state.claimError = null;
  m.state.goneUpdateFilters = [];
  m.state.claimDeletes = 0;
  m.state.sendCalls = [];
  m.state.templateCalls = [];
  m.state.logs = [];
});

describe("trigger filtering", () => {
  it("ignores runs from other surfaces sharing agent.run.completed", async () => {
    m.state.run = baseRun({ trigger: "telegram" });
    expect(await replyOne("r1")).toMatchObject({ skip: "not_whatsapp_triage" });
    expect(m.state.sendCalls).toHaveLength(0);
  });

  it("skips when the operator delegated the reply to a child run", async () => {
    m.state.run = baseRun({
      payload: { whatsapp: { wa_id: "1", phone_number_id: "PN1" }, whatsapp_reply_delegated: true },
    });
    expect(await replyOne("r1")).toMatchObject({ skip: "whatsapp_reply_delegated" });
  });
});

describe("the 24h window", () => {
  it("passes the LIVE binding deadline to the sender, not anything from the run payload", async () => {
    await replyOne("r1");
    expect(m.state.sendCalls[0]).toMatchObject({ windowExpiresAt: OPEN });
  });

  it("sends the TEMPLATE and withholds the answer when the window has closed", async () => {
    m.state.send = { ok: false, windowClosed: true, sent: 0, error: "window_closed" };
    const res = await replyOne("r1");

    expect(res).toMatchObject({ skip: "window_expired", template_sent: true });
    expect(m.state.templateCalls).toHaveLength(1);
    expect(JSON.stringify(m.state.templateCalls[0])).not.toContain("ad spend breakdown");
    expect(m.state.logs.some((l) => l.code === "whatsapp.reply.window_expired")).toBe(true);
  });

  it("does NOT stack a template on top of a partial delivery", async () => {
    m.state.send = { ok: false, windowClosed: true, sent: 2, error: "window_closed_mid_send" };
    const res = await replyOne("r1");

    expect(res).toMatchObject({ skip: "window_closed_mid_send", sent: 2 });
    expect(m.state.templateCalls).toHaveLength(0);
    expect(m.state.claimDeletes).toBe(0);
  });
});

describe("egress trust", () => {
  it("drops the reply when the binding is no longer this tenant's enabled thread", async () => {
    m.state.binding = null;
    expect(await replyOne("r1")).toMatchObject({ skip: "binding_not_current" });
    expect(m.state.sendCalls).toHaveLength(0);
  });

  it("scopes the recipient-gone disable to THIS tenant and this thread", async () => {
    m.state.send = { ok: false, gone: true, sent: 0, error: "recipient gone" };
    await replyOne("r1");
    const keys = Object.fromEntries(m.state.goneUpdateFilters);
    expect(keys.tenant_id).toBe(TENANT);
    expect(keys.wa_id).toBe("14085551234");
    expect(keys.phone_number_id).toBe("PN1");
  });

  it("never posts a failed run's stack trace to the customer", async () => {
    m.state.run = baseRun({ status: "failed", output_text: "Error: boom\n  at x.ts:1" });
    expect(await replyOne("r1")).toMatchObject({ skip: "run_not_success" });
    expect(m.state.sendCalls).toHaveLength(0);
    expect(m.state.claimDeletes).toBe(1);
  });
});

describe("retry contract", () => {
  it("THROWS on a transient zero-chunk failure so Inngest spends its retry", async () => {
    m.state.send = { ok: false, sent: 0, error: "ETIMEDOUT" };
    await expect(replyOne("r1")).rejects.toThrow(/whatsapp_send_failed/);
    expect(m.state.claimDeletes).toBe(1);
  });

  it("does NOT throw when the surface is disabled mid-flight", async () => {
    m.state.send = { ok: false, disabled: true, sent: 0, error: "whatsapp_disabled" };
    expect(await replyOne("r1")).toMatchObject({ skip: "whatsapp_disabled" });
    expect(m.state.claimDeletes).toBe(1);
  });

  it("skips when another worker already claimed the run", async () => {
    m.state.claimError = { message: "duplicate key value violates unique constraint" };
    expect(await replyOne("r1")).toMatchObject({ skip: "reply_already_handled" });
    expect(m.state.sendCalls).toHaveLength(0);
  });
});

describe("business-number egress guard", () => {
  const KEYS = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("skips WITHOUT claiming or sending when this host is configured for a different number", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "t";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "PN-TEST";
    process.env.WHATSAPP_APP_SECRET = "s";
    process.env.WHATSAPP_VERIFY_TOKEN = "v";
    m.state.run = baseRun();
    expect(await replyOne("r1")).toMatchObject({ skip: "number_mismatch" });
    expect(m.state.sendCalls).toHaveLength(0);
    expect(m.state.templateCalls).toHaveLength(0);
    expect(m.state.claimDeletes).toBe(0);
    expect(m.state.logs.some((l) => l.code === "whatsapp.reply.number_mismatch")).toBe(true);
  });

  it("replies normally when this host owns the thread's number", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "t";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "PN1";
    process.env.WHATSAPP_APP_SECRET = "s";
    process.env.WHATSAPP_VERIFY_TOKEN = "v";
    m.state.run = baseRun();
    expect(await replyOne("r1")).toMatchObject({ sent: true });
    expect(m.state.sendCalls).toHaveLength(1);
  });
});

describe("handoff child reply", () => {
  it("posts the projected status line instead of a jargon write-up", async () => {
    const jargon = "The sandbox is on the wrong repo; re-dispatch with repo_hint. No envelope emitted.";
    m.state.run = baseRun({
      agent_slug: "engineer",
      output_text: jargon,
      outcome: {
        deliverable: jargon,
        side_effect: { kind: "refused", reason: "refused_envelope" },
        failure: { class: "none" },
        liveness_tier: "plan_only",
      },
      parsed: null,
      payload: {
        whatsapp: { wa_id: "14085551234", phone_number_id: "PN1" },
        whatsapp_handoff_child: true,
      },
    });
    await replyOne("r1");
    expect(m.state.sendCalls[0]).toMatchObject({ text: "No changes were made." });
  });

  it("a handoff child that FAILED terminally posts the 'couldn't' line, not silence", async () => {
    m.state.run = baseRun({
      agent_slug: "engineer",
      status: "failed",
      output_text: "Error: boom\n  at x.ts:1",
      outcome: null,
      parsed: null,
      payload: {
        whatsapp: { wa_id: "14085551234", phone_number_id: "PN1" },
        whatsapp_handoff_child: true,
      },
    });
    expect(await replyOne("r1")).toMatchObject({ sent: true });
    const text = String(m.state.sendCalls[0]?.text ?? "");
    expect(text.startsWith("This didn't finish.")).toBe(true);
    expect(text).not.toMatch(/boom|x\.ts|⚠/);
    expect(m.state.claimDeletes).toBe(0);
  });

  it("a non-handoff failed run keeps the retry contract (silent, claim released)", async () => {
    m.state.run = baseRun({ status: "failed" });
    expect(await replyOne("r1")).toMatchObject({ skip: "run_not_success" });
    expect(m.state.sendCalls).toHaveLength(0);
    expect(m.state.claimDeletes).toBe(1);
  });

  it("a refused run posts its explanation instead of going silent (#4788)", async () => {
    m.state.run = baseRun({ status: "failed", output_text: "I can't start the first AI-answer check. It has never run.", outcome: { failure: { class: "policy_refusal", raw_error: null } } });
    await replyOne("r1");
    expect(m.state.sendCalls[0]).toMatchObject({ text: "I can't start the first AI-answer check. It has never run." });
  });

  it("a non-handoff run still posts its output_text", async () => {
    await replyOne("r1");
    expect(m.state.sendCalls[0]).toMatchObject({ text: "here is your ad spend breakdown" });
  });
});
