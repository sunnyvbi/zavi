
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const state = {
    inbound: null as Record<string, unknown> | null,
    sends: [] as Record<string, unknown>[],
    ingests: [] as Record<string, unknown>[],
    events: [] as string[],
    inboundErr: null as { message: string } | null,
    sendMode: "ok" as "ok" | "throw" | "refuse",
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
    if (table === "agent_runs")
      return chain({
        maybeSingle: async () => ({
          data: {
            tenant_id: "11111111-1111-1111-1111-111111111111",
            trigger: "email",
            status: "success",
            output_text: "You have 247 active hosts right now, up 12 from last week.",
            agent_slug: "operator",
            outcome: null,
            parsed: null,
            payload: {
              email: { email_message_id: "em1", from: "founder@acme.com", envelope_to: "upcarai@inbox.zaviagent.com" },
            },
          },
        }),
      });
    if (table === "decisions") {
      const b: any = { select: () => b, eq: async () => ({ data: [] }) };
      return b;
    }
    if (table === "email_messages")
      return chain({
        maybeSingle: async () => ({ data: state.inbound, error: state.inboundErr }),
        delete: () => {
          state.events.push("delete");
          return chain({});
        },
      });
    if (table === "email_triage_claims") {
      const b: any = { update: () => b, eq: () => b, is: () => b, select: async () => ({ data: [{ dedup_key: "dk1" }] }) };
      return b;
    }
    throw new Error(`unexpected table ${table}`);
  });
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "tenant_member_emails") return { data: ["founder@acme.com"], error: null };
    if (name === "ingest_email_message") {
      state.ingests.push(args);
      state.events.push("ingest");
    }
    return { data: [], error: null };
  });
  return { state, from, rpc };
});

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: m.from, rpc: m.rpc }) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));
vi.mock("@/email/sendAgentMailReply", () => ({
  sendAgentMailReply: async (a: Record<string, unknown>) => {
    m.state.sends.push(a);
    m.state.events.push("send");
    if (m.state.sendMode === "throw") throw new Error("sendgrid 500");
    if (m.state.sendMode === "refuse") return { sent: false, reason: "recipient_suppressed" };
    return { sent: true, messageId: a.message_id as string };
  },
}));

import { replyOne, replyThreadingIds } from "../email-triage-reply";

const GMAIL = "<CAbc+XyZ@mail.gmail.com>";

beforeEach(() => {
  m.state.sends = [];
  m.state.ingests = [];
  m.state.events = [];
  m.state.inboundErr = null;
  m.state.sendMode = "ok";
  m.state.inbound = {
    dedup_key: "dk1",
    thread_id: "t1",
    subject: "Re: Your growth note",
    rfc_message_id: "cabc+xyz@mail.gmail.com",
    references_chain: ["sg-unknown@sendgrid.net", "zavi-root@inbox.zaviagent.com"],
    to_addresses: [],
    cc_addresses: [],
    headers: {
      "Message-ID": [GMAIL],
      References: ["<SG-Unknown@sendgrid.net> <zavi-root@inbox.zaviagent.com>"],
    },
    email_threads: { root_message_id: "zavi-root@inbox.zaviagent.com" },
  };
});

describe("email-triage-reply threading", () => {
  it("replies with the sender's original-case ids", async () => {
    expect(await replyOne("r1")).toMatchObject({ sent: true });
    const s = m.state.sends[0];
    expect(s.in_reply_to).toBe(GMAIL);
    expect(s.references).toEqual(["<SG-Unknown@sendgrid.net>", "<zavi-root@inbox.zaviagent.com>", GMAIL]);
  });

  it("records the outbound row before sending, under the Message-ID it sends", async () => {
    await replyOne("r1");
    expect(m.state.events).toEqual(["ingest", "send"]);
    const sent = m.state.sends[0].message_id as string;
    expect(sent).toMatch(/^<zavi-.+@inbox\.zaviagent\.com>$/);
    expect(m.state.ingests[0].p_rfc_message_id).toBe(sent.slice(1, -1).toLowerCase());
  });

  it("forgets the outbound row when the send throws or is refused", async () => {
    m.state.sendMode = "throw";
    expect(await replyOne("r1")).toMatchObject({ skip: "send_failed" });
    expect(m.state.events).toEqual(["ingest", "send", "delete"]);
    m.state.events = [];
    m.state.sendMode = "refuse";
    expect(await replyOne("r1")).toMatchObject({ skip: "recipient_suppressed" });
    expect(m.state.events).toEqual(["ingest", "send", "delete"]);
  });

  it("a retry of the same run saves and sends the same Message-ID", async () => {
    m.state.sendMode = "throw";
    await replyOne("r1");
    m.state.sendMode = "ok";
    await replyOne("r1");
    expect(m.state.sends[0].message_id).toBe(m.state.sends[1].message_id);
    expect(m.state.ingests[0].p_rfc_message_id).toBe(m.state.ingests[1].p_rfc_message_id);
  });

  it("roots on the inbound's thread when the embed comes back as an array", async () => {
    m.state.inbound = { ...m.state.inbound, email_threads: [{ root_message_id: "zavi-root@inbox.zaviagent.com" }] };
    await replyOne("r1");
    expect(m.state.ingests[0].p_root_message_id).toBe("zavi-root@inbox.zaviagent.com");
  });

  it("throws (so the step retries) when the inbound read errors", async () => {
    m.state.inboundErr = { message: "connection reset" };
    await expect(replyOne("r1")).rejects.toThrow(/inbound read failed/);
    expect(m.state.events).toEqual([]);
  });

  it("roots on the inbound's thread and keeps the references", async () => {
    await replyOne("r1");
    const row = m.state.ingests[0];
    expect(row.p_root_message_id).toBe("zavi-root@inbox.zaviagent.com");
    expect(row.p_references_chain).toEqual([
      "sg-unknown@sendgrid.net",
      "zavi-root@inbox.zaviagent.com",
      "cabc+xyz@mail.gmail.com",
    ]);
  });
});

describe("replyThreadingIds", () => {
  it("falls back to the stored ids when no raw header is kept", () => {
    expect(
      replyThreadingIds({ rfc_message_id: "m1@x", references_chain: ["r0@x"], headers: null }),
    ).toEqual({ inReplyTo: "m1@x", references: ["r0@x", "m1@x"] });
  });

  it("ignores a raw header id we never stored", () => {
    const out = replyThreadingIds({
      rfc_message_id: "m1@x",
      references_chain: [],
      headers: { references: "<Other@Evil>", "message-id": "<M1@X>" },
    });
    expect(out).toEqual({ inReplyTo: "<M1@X>", references: ["<M1@X>"] });
  });
});
