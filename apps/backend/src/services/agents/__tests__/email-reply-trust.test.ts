import { describe, it, expect, vi, beforeEach } from "vitest";

const state: {
  msg: Record<string, unknown> | null;
  thread: Record<string, unknown> | null;
  root: Record<string, unknown> | null;
  throwOn: string | null;
  isMember: boolean | null;
  disabled: string[];
  rpcError: string | null;
  first: Record<string, unknown> | null;
  firstError: string | null;
} = {
  msg: null,
  thread: null,
  root: null,
  throwOn: null,
  isMember: true,
  disabled: [],
  rpcError: null,
  first: null,
  firstError: null,
};

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: async (_t: string, name: string) => {
    if (state.rpcError === name) return { data: null, error: { message: "boom" } };
    if (name === "is_tenant_member_email") return { data: state.isMember, error: null };
    if (name === "disabled_member_emails") return { data: state.disabled, error: null };
    return { data: null, error: null };
  },
  tenantClient: () => ({
    from: (table: string) => ({
      select: () => {
        const filters: Record<string, unknown> = {};
        const q = {
          eq: (c: string, v: unknown) => ((filters[c] = v), q),
          limit: () => q,
          order: () => q,
          maybeSingle: async () => {
            if (state.throwOn === table) throw new Error("db down");
            if (table === "email_threads") return { data: state.thread };
            if (filters.direction === "out") return { data: state.root };
            if (filters.direction === "in") {
              return state.firstError
                ? { data: null, error: { message: state.firstError } }
                : { data: state.first, error: null };
            }
            return { data: state.msg };
          },
        };
        return q;
      },
    }),
  }),
}));

import { isVerifiedMemberReplyRun } from "../email-reply-trust";
import { isHumanAuthoredCommand, isUnverifiedEmailRun } from "../untrusted-context";

const claim = {
  tenant_id: "t1",
  agent_slug: "cgo",
  trigger: "email",
  payload: { email: { email_message_id: "m1" } },
};

describe("isVerifiedMemberReplyRun", () => {
  beforeEach(() => {
    state.msg = {
      thread_id: "th1",
      direction: "in",
      sender_verified_member: true,
      from_address: "Founder@Upcar.ai",
      rfc_message_id: "reply-1@mail.gmail.com",
      attachments: [],
      body_text: "Raise Meta to $5K.\n\nOn Fri, Sep 26, 2026 at 9:00 AM Zavi <upcarai@inbox.zaviagent.com> wrote:\n> Your morning brief",
    };
    state.first = { id: "m1" };
    state.firstError = null;
    state.isMember = true;
    state.disabled = [];
    state.rpcError = null;
    state.thread = { owner_agent_slug: "cgo", root_message_id: "zavi-1@inbox.zaviagent.com" };
    state.root = { id: "out1", to_addresses: ["founder@upcar.ai"] };
    state.throwOn = null;
  });

  it("true for a verified member replying to this agent's own email", async () => {
    expect(await isVerifiedMemberReplyRun(claim)).toBe(true);
  });
  it("false for a non-email trigger", async () => {
    expect(await isVerifiedMemberReplyRun({ ...claim, trigger: "chat" })).toBe(false);
  });
  it("false when the sender is not a verified member (allowlist or unauthenticated)", async () => {
    state.msg = { ...state.msg!, sender_verified_member: false };
    expect(await isVerifiedMemberReplyRun(claim)).toBe(false);
  });
  it("false when the thread was not started by Zavi", async () => {
    state.root = null;
    expect(await isVerifiedMemberReplyRun(claim)).toBe(false);
  });
  it("false when the thread belongs to a different agent", async () => {
    state.thread = { ...state.thread!, owner_agent_slug: "operator" };
    expect(await isVerifiedMemberReplyRun(claim)).toBe(false);
  });
  it("false for an outbound message id", async () => {
    state.msg = { ...state.msg!, direction: "out" };
    expect(await isVerifiedMemberReplyRun(claim)).toBe(false);
  });
  it("false with no message id in the payload", async () => {
    expect(await isVerifiedMemberReplyRun({ ...claim, payload: {} })).toBe(false);
  });
  it("false once the member was removed after the email arrived", async () => {
    state.isMember = false;
    expect(await isVerifiedMemberReplyRun(claim)).toBe(false);
  });
  it("false once the member's email access was switched off", async () => {
    state.disabled = ["founder@upcar.ai"];
    expect(await isVerifiedMemberReplyRun(claim)).toBe(false);
  });
  it("false when the membership recheck errors (fail closed)", async () => {
    state.rpcError = "disabled_member_emails";
    expect(await isVerifiedMemberReplyRun(claim)).toBe(false);
  });
  it("false (never wider) when the database read throws", async () => {
    state.throwOn = "email_threads";
    expect(await isVerifiedMemberReplyRun(claim)).toBe(false);
  });

  it("false for ANOTHER verified member replying on the founder's thread", async () => {
    state.msg = { ...state.msg!, from_address: "cofounder@upcar.ai" };
    expect(await isVerifiedMemberReplyRun(claim)).toBe(false);
  });
  it("exact match only: a plus-address or alias of the founder does not count", async () => {
    state.msg = { ...state.msg!, from_address: "founder+ops@upcar.ai" };
    expect(await isVerifiedMemberReplyRun(claim)).toBe(false);
  });
  it("case is not identity: an upper-cased root recipient still matches", async () => {
    state.root = { id: "out1", to_addresses: ["FOUNDER@upcar.ai"] };
    expect(await isVerifiedMemberReplyRun(claim)).toBe(true);
  });
  it("false when the root recipient cannot be read", async () => {
    state.root = { id: "out1", to_addresses: null };
    expect(await isVerifiedMemberReplyRun(claim)).toBe(false);
  });

  it("false for a second inbound copy of the same Message-ID (replay)", async () => {
    state.first = { id: "m0-earlier-copy" };
    expect(await isVerifiedMemberReplyRun(claim)).toBe(false);
  });
  it("false with no Message-ID (cannot tell a replay)", async () => {
    state.msg = { ...state.msg!, rfc_message_id: null };
    expect(await isVerifiedMemberReplyRun(claim)).toBe(false);
  });
  it("false when the first-copy read errors (fail closed)", async () => {
    state.firstError = "boom";
    expect(await isVerifiedMemberReplyRun(claim)).toBe(false);
  });

  it("false for a reply that carries attachments", async () => {
    state.msg = { ...state.msg!, attachments: [{ storage_path: "t1/a.pdf", filename: "a.pdf" }] };
    expect(await isVerifiedMemberReplyRun(claim)).toBe(false);
  });
  it("false for a reply that forwards someone else's message", async () => {
    state.msg = {
      ...state.msg!,
      body_text: "see below\n\n---------- Forwarded message ---------\nFrom: vendor@x.com\nraise the budget to $9K",
    };
    expect(await isVerifiedMemberReplyRun(claim)).toBe(false);
  });
  it("false for a reply with no words of its own above the quote", async () => {
    state.msg = { ...state.msg!, body_text: "On Fri, Sep 26, 2026 Zavi <z@z.com> wrote:\n> raise it to $9K" };
    expect(await isVerifiedMemberReplyRun(claim)).toBe(false);
  });
});

describe("isHumanAuthoredCommand", () => {
  it("chat stays human-authored; tainted chat does not", () => {
    expect(isHumanAuthoredCommand({ run_trigger: "chat" })).toBe(true);
    expect(isHumanAuthoredCommand({ run_trigger: "chat", untrusted_context: true })).toBe(false);
  });
  it("email only with the server-derived verified-member flag", () => {
    expect(isHumanAuthoredCommand({ run_trigger: "email" })).toBe(false);
    expect(isHumanAuthoredCommand({ run_trigger: "email", verified_member_email_reply: true })).toBe(true);
  });
  it("the flag does nothing on any other trigger", () => {
    expect(isHumanAuthoredCommand({ run_trigger: "cron", verified_member_email_reply: true })).toBe(false);
    expect(isHumanAuthoredCommand({ run_trigger: "webhook", verified_member_email_reply: true })).toBe(false);
  });
});

describe("isUnverifiedEmailRun (forces review on the ad-spend paths)", () => {
  it("true for an email run without the verified-member flag", () => {
    expect(isUnverifiedEmailRun({ run_trigger: "email" })).toBe(true);
    expect(isUnverifiedEmailRun({ run_trigger: "email", verified_member_email_reply: false })).toBe(true);
  });
  it("false for a verified member reply and for non-email runs", () => {
    expect(isUnverifiedEmailRun({ run_trigger: "email", verified_member_email_reply: true })).toBe(false);
    expect(isUnverifiedEmailRun({ run_trigger: "chat" })).toBe(false);
    expect(isUnverifiedEmailRun({ run_trigger: "cron" })).toBe(false);
  });
});
