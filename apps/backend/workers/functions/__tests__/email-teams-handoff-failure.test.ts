
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const state = {
    run: null as Record<string, unknown> | null,
    emailSends: [] as Record<string, unknown>[],
    teamsPosts: [] as Record<string, unknown>[],
  };
  const chain = (terminal: Record<string, unknown>) => {
    const b: any = new Proxy(
      {},
      {
        get(_t, k) {
          if (k in terminal) return terminal[k as string];
          if (k === "then") return undefined;
          return () => b;
        },
      },
    );
    return b;
  };
  const from = vi.fn((table: string) => {
    if (table === "agent_runs") return chain({ maybeSingle: async () => ({ data: state.run }) });
    if (table === "decisions") {
      const b: any = { select: () => b, eq: async () => ({ data: [] }) };
      return b;
    }
    if (table === "email_messages")
      return chain({
        maybeSingle: async () => ({
          data: {
            dedup_key: "dk1",
            thread_id: "t1",
            subject: "Help",
            rfc_message_id: "<m1@x>",
            references_chain: [],
            to_addresses: [],
            cc_addresses: [],
          },
        }),
      });
    if (table === "email_triage_claims") {
      const b: any = { update: () => b, eq: () => b, is: () => b, select: async () => ({ data: [{ dedup_key: "dk1" }] }) };
      return b;
    }
    if (table === "teams_reply_claims")
      return { insert: async () => ({ error: null }), delete: () => ({ eq: async () => ({ error: null }) }) };
    throw new Error(`unexpected table ${table}`);
  });
  const rpc = vi.fn(async (name: string) => {
    if (name === "tenant_member_emails") return { data: ["founder@acme.com"], error: null };
    return { data: [], error: null };
  });
  return { state, from, rpc };
});

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: m.from, rpc: m.rpc }) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));
vi.mock("@/email/sendAgentMailReply", () => ({
  sendAgentMailReply: async (a: Record<string, unknown>) => {
    m.state.emailSends.push(a);
    return { sent: true };
  },
}));
vi.mock("@/services/tools/teams/_client", () => ({
  postTeamsReply: async (a: Record<string, unknown>) => {
    m.state.teamsPosts.push(a);
    return { ok: true };
  },
}));

import { replyOne as emailReplyOne } from "../email-triage-reply";
import { replyOne as teamsReplyOne } from "../teams-triage-reply";

const TENANT = "11111111-1111-1111-1111-111111111111";

function emailRun(over: Record<string, unknown> = {}) {
  return {
    tenant_id: TENANT,
    trigger: "email",
    status: "failed",
    output_text: "Error: boom\n  at x.ts:1",
    agent_slug: "engineer",
    outcome: null,
    parsed: null,
    payload: {
      email: { email_message_id: "em1", from: "founder@acme.com", envelope_to: "zavi@inbox.zaviagent.com" },
      handoff_child: true,
    },
    ...over,
  };
}

function teamsRun(over: Record<string, unknown> = {}) {
  return {
    tenant_id: TENANT,
    trigger: "teams",
    status: "failed",
    output_text: "Error: boom\n  at x.ts:1",
    agent_slug: "engineer",
    outcome: null,
    parsed: null,
    payload: { teams: { conversation_reference: { id: "c1" } }, handoff_child: true },
    ...over,
  };
}

beforeEach(() => {
  m.state.emailSends = [];
  m.state.teamsPosts = [];
});

describe("email-triage-reply — failed handoff child", () => {
  it("sends the 'This didn't finish' status, never the raw error", async () => {
    m.state.run = emailRun();
    expect(await emailReplyOne("r1")).toMatchObject({ sent: true });
    const body = String(m.state.emailSends[0]?.body_text ?? "");
    expect(body.startsWith("This didn't finish.")).toBe(true);
    expect(body).not.toMatch(/boom|x\.ts/);
  });

  it("a non-handoff failed run stays silent", async () => {
    m.state.run = emailRun({ payload: { email: { email_message_id: "em1", from: "founder@acme.com" } } });
    expect(await emailReplyOne("r1")).toMatchObject({ skip: "run_not_success" });
    expect(m.state.emailSends).toHaveLength(0);
  });

  it("a handoff child in a non-terminal status stays silent", async () => {
    m.state.run = emailRun({ status: "running" });
    expect(await emailReplyOne("r1")).toMatchObject({ skip: "run_not_success" });
    expect(m.state.emailSends).toHaveLength(0);
  });
});

describe("teams-triage-reply — failed handoff child", () => {
  it("posts the 'This didn't finish' status, never the raw error", async () => {
    m.state.run = teamsRun();
    expect(await teamsReplyOne("r1")).toMatchObject({ sent: true });
    const text = String(m.state.teamsPosts[0]?.text ?? "");
    expect(text.startsWith("This didn't finish.")).toBe(true);
    expect(text).not.toMatch(/boom|x\.ts/);
  });

  it("a non-handoff failed run stays silent", async () => {
    m.state.run = teamsRun({ payload: { teams: { conversation_reference: { id: "c1" } } } });
    expect(await teamsReplyOne("r1")).toMatchObject({ skip: "run_not_success" });
    expect(m.state.teamsPosts).toHaveLength(0);
  });
});
