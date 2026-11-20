import { describe, it, expect, vi, beforeEach } from "vitest";

let verified = true;
vi.mock("@/services/agents/email-reply-trust", () => ({ isVerifiedMemberReplyRun: async () => verified }));
let body: string | null = "Keep Reddit.\n\nOn Sep 26, Zavi wrote:\n> old note";
let fromAddress = "OWNER@acme.test";
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { body_text: body, from_address: fromAddress }, error: null }) };
    return { from: () => q };
  },
}));
let owner: string | null = "owner@acme.test";
vi.mock("@/email/sendAuthEmail", () => ({ resolveTenantOwnerEmail: async () => owner }));
let slackUser: string | undefined = "U1";
const lookups: unknown[] = [];
vi.mock("@/services/tools/slack/_client", () => ({
  slackFetch: async (_t: string, method: string, b: Record<string, unknown>, team?: string) => {
    lookups.push([method, b, team]);
    return { user: slackUser ? { id: slackUser } : undefined };
  },
}));

import { founderReplyFromRun } from "../cgo-reply";

const slackRun = (over: Record<string, unknown> = {}) => ({
  tenant_id: "t-1",
  run_id: "run-r",
  trigger: "slack",
  payload: { cgo_reply: { via: "slack" }, slack: { user: "U1", team_id: "T1", text: "Keep Reddit." }, ...over },
});
const emailRun = { tenant_id: "t-1", run_id: "run-e", trigger: "email", payload: { cgo_reply: { via: "email" }, email: { email_message_id: "m1" } } };

beforeEach(() => {
  verified = true;
  body = "Keep Reddit.\n\nOn Sep 26, Zavi wrote:\n> old note";
  owner = "owner@acme.test";
  fromAddress = "OWNER@acme.test";
  slackUser = "U1";
  lookups.length = 0;
});

describe("founderReplyFromRun", () => {
  it("email: a verified founder reply, their own words only", async () => {
    expect(await founderReplyFromRun(emailRun)).toEqual({ via: "email", text: "Keep Reddit.", reply_run_id: "run-e" });
  });

  it("email: a verified member who is no longer the owner is not the founder", async () => {
    fromAddress = "alice@acme.test";
    expect(await founderReplyFromRun(emailRun)).toBeNull();
  });

  it("email: not verified, or nothing of their own above the quote, is no reply", async () => {
    verified = false;
    expect(await founderReplyFromRun(emailRun)).toBeNull();
    verified = true;
    body = "> just the quote";
    expect(await founderReplyFromRun(emailRun)).toBeNull();
  });

  it("slack: the replier must still be the owner's account in that workspace", async () => {
    expect(await founderReplyFromRun(slackRun())).toEqual({ via: "slack", text: "Keep Reddit.", reply_run_id: "run-r" });
    expect(lookups).toEqual([["users.lookupByEmail", { email: "owner@acme.test" }, "T1"]]);
    slackUser = "U-someone-else";
    expect(await founderReplyFromRun(slackRun())).toBeNull();
    owner = null;
    expect(await founderReplyFromRun(slackRun())).toBeNull();
  });

  it("no marker, a marker on the wrong trigger, or a Slack error: no reply", async () => {
    expect(await founderReplyFromRun({ ...slackRun(), payload: { slack: { user: "U1", text: "x" } } })).toBeNull();
    expect(await founderReplyFromRun({ ...slackRun(), trigger: "chat" })).toBeNull();
    expect(await founderReplyFromRun({ ...emailRun, trigger: "slack" })).toBeNull();
    slackUser = undefined;
    expect(await founderReplyFromRun(slackRun())).toBeNull();
  });
});
