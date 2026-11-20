
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  approvers: {} as Record<string, string>,
  fail: false,
  calls: [] as Array<{ tenant_id: string; team_id: string | null | undefined; slack_user_id: string | null | undefined }>,
}));
vi.mock("@/services/slack/resolve-member", () => ({
  resolveSlackApprover: async (
    _svc: unknown,
    a: { tenant_id: string; team_id: string | null | undefined; slack_user_id: string | null | undefined },
  ) => {
    db.calls.push(a);
    if (db.fail) return null;
    return db.approvers[`${a.tenant_id}:${a.team_id}:${a.slack_user_id}`] ?? null;
  },
}));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: () => ({}) }));

import {
  sendReminderEmail,
  reminderEmailSubject,
  defaultReminderEmailDeps,
  type ReminderEmailDeps,
} from "@/services/agents/reminder-email";

const THREAD = "11111111-2222-3333-4444-555555555555";

function deps(over: Partial<ReminderEmailDeps> = {}) {
  const members: Record<string, string[]> = { t1: ["u1"], t2: ["u2"] };
  const emails: Record<string, string> = { u1: "founder@acme.test", u2: "other@rival.test" };
  const sent: Array<Parameters<ReminderEmailDeps["send"]>[0]> = [];
  const d: ReminderEmailDeps = {
    slackLinkedUser: defaultReminderEmailDeps({} as never).slackLinkedUser,
    isMember: vi.fn(async (tid: string, uid: string) => (members[tid] ?? []).includes(uid)),
    emailOf: vi.fn(async (uid: string) => emails[uid] ?? null),
    scrub: (t) => t,
    send: vi.fn(async (msg) => {
      sent.push(msg);
    }),
    baseUrl: () => "https://www.zaviagent.com",
    ...over,
  };
  return { d, sent };
}

const BASE = {
  tenant_id: "t1",
  agent_slug: "operator",
  created_by: "u1",
  deliver: { kind: "chat_thread", thread_id: THREAD },
};

describe("sendReminderEmail", () => {
  it("emails the creator the note for a PING, subject 'Reminder: <note>'", async () => {
    const { d, sent } = deps();
    const r = await sendReminderEmail({ ...BASE, mode: "ping", note: "Call the landlord about the lease" }, d);

    expect(r).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("founder@acme.test");
    expect(sent[0].tenant_id).toBe("t1");
    expect(sent[0].subject).toBe("Reminder: Call the landlord about the lease");
    expect(sent[0].text).toContain("Call the landlord about the lease");
    expect(sent[0].html).toContain("Call the landlord about the lease");
    expect(sent[0].text).not.toContain("Zavi is working on it");
    expect(sent[0].text).not.toMatch(/—/);
  });

  it("for a RUN, adds a link to the chat thread where the result lands", async () => {
    const { d, sent } = deps();
    await sendReminderEmail({ ...BASE, mode: "run", note: "Summarise yesterday's signups" }, d);

    expect(sent[0].text).toContain("Summarise yesterday's signups");
    expect(sent[0].text).toContain("The result will be posted in your Zavi chat.");
    expect(sent[0].text).toContain(`https://www.zaviagent.com/workspace/${THREAD}`);
    expect(sent[0].html).toContain(`https://www.zaviagent.com/workspace/${THREAD}`);
  });

  it("truncates a long note in the subject to about 60 chars", () => {
    const s = reminderEmailSubject("x".repeat(200));
    expect(s.startsWith("Reminder: ")).toBe(true);
    expect(s.length).toBeLessThanOrEqual("Reminder: ".length + 60);
  });

  it("escapes the note in the HTML", async () => {
    const { d, sent } = deps();
    await sendReminderEmail({ ...BASE, mode: "ping", note: "<script>x</script>" }, d);
    expect(sent[0].html).not.toContain("<script>x</script>");
  });

  it("skips cleanly when there is no creator (Slack-origin reminder)", async () => {
    const { d, sent } = deps();
    const r = await sendReminderEmail({ ...BASE, created_by: null, mode: "ping", note: "n" }, d);
    expect(r).toEqual({ sent: false, reason: "no_creator" });
    expect(sent).toHaveLength(0);
  });

  it("skips cleanly when the creator has no email", async () => {
    const { d, sent } = deps({ emailOf: async () => null });
    const r = await sendReminderEmail({ ...BASE, mode: "ping", note: "n" }, d);
    expect(r).toEqual({ sent: false, reason: "no_creator_email" });
    expect(sent).toHaveLength(0);
  });

  it("never emails a user who is not a member of the reminder's tenant", async () => {
    const { d, sent } = deps();
    const r = await sendReminderEmail({ ...BASE, created_by: "u2", mode: "ping", note: "n" }, d);
    expect(r).toEqual({ sent: false, reason: "creator_not_member" });
    expect(d.isMember).toHaveBeenCalledWith("t1", "u2");
    expect(d.emailOf).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("returns a reason instead of throwing when the send fails", async () => {
    const { d } = deps({
      send: async () => {
        throw new Error("SendGrid 403");
      },
    });
    const r = await sendReminderEmail({ ...BASE, mode: "ping", note: "n" }, d);
    expect(r.sent).toBe(false);
    expect(r).toMatchObject({ reason: expect.stringContaining("SendGrid 403") });
  });

  it("returns a reason instead of throwing when the membership read fails", async () => {
    const { d } = deps({
      isMember: async () => {
        throw new Error("db down");
      },
    });
    const r = await sendReminderEmail({ ...BASE, mode: "ping", note: "n" }, d);
    expect(r.sent).toBe(false);
  });
});

describe("sendReminderEmail for a Slack-origin reminder (no created_by)", () => {
  const DM = { kind: "slack_dm", slack_user_id: "U123", team_id: "T1" };
  const SLACK = { ...BASE, created_by: null, slack_user_id: "U123", deliver: DM, mode: "ping" as const, note: "Ship it" };

  beforeEach(() => {
    db.fail = false;
    db.calls = [];
    db.approvers = { "t1:T1:U123": "u1" };
  });

  it("emails the Zavi account linked to that Slack user in the reminder's own workspace and tenant", async () => {
    const { d, sent } = deps();
    const r = await sendReminderEmail(SLACK, d);
    expect(r).toEqual({ sent: true });
    expect(db.calls).toEqual([{ tenant_id: "t1", team_id: "T1", slack_user_id: "U123" }]);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("founder@acme.test");
    expect(d.isMember).toHaveBeenCalledWith("t1", "u1");
  });

  it("reads the team from a slack_thread target too", async () => {
    const { d, sent } = deps();
    const deliver = { kind: "slack_thread", channel_id: "C1", thread_ts: "1.2", team_id: "T1" };
    expect(await sendReminderEmail({ ...SLACK, deliver }, d)).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
  });

  it("sends nothing when the same Slack id is linked only in ANOTHER workspace", async () => {
    db.approvers = { "t1:T2:U123": "u1" };
    const { d, sent } = deps();
    expect(await sendReminderEmail(SLACK, d)).toEqual({ sent: false, reason: "no_slack_link" });
    expect(d.emailOf).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("ignores a link that lives in another tenant", async () => {
    db.approvers = { "t2:T1:U123": "u2" };
    const { d, sent } = deps();
    expect(await sendReminderEmail(SLACK, d)).toEqual({ sent: false, reason: "no_slack_link" });
    expect(sent).toHaveLength(0);
  });

  it("sends nothing when the Slack user is not linked", async () => {
    db.approvers = {};
    const { d, sent } = deps();
    expect(await sendReminderEmail(SLACK, d)).toEqual({ sent: false, reason: "no_slack_link" });
    expect(sent).toHaveLength(0);
  });

  it("sends nothing, and looks nothing up, when the stored target has no team_id", async () => {
    const { d, sent } = deps();
    const r = await sendReminderEmail({ ...SLACK, deliver: { kind: "slack_dm", slack_user_id: "U123" } }, d);
    expect(r).toEqual({ sent: false, reason: "no_slack_team" });
    expect(db.calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("sends nothing for a non-Slack target (no team to resolve in)", async () => {
    const { d, sent } = deps();
    const r = await sendReminderEmail({ ...SLACK, deliver: { kind: "chat_thread", thread_id: THREAD } }, d);
    expect(r).toEqual({ sent: false, reason: "no_slack_team" });
    expect(sent).toHaveLength(0);
  });

  it("sends nothing when the lookup fails (resolver fails closed)", async () => {
    db.fail = true;
    const { d, sent } = deps();
    expect(await sendReminderEmail(SLACK, d)).toEqual({ sent: false, reason: "no_slack_link" });
    expect(sent).toHaveLength(0);
  });

  it("prefers created_by when present and never consults the Slack link", async () => {
    const { d, sent } = deps({ slackLinkedUser: vi.fn(async () => "u2") });
    await sendReminderEmail({ ...SLACK, created_by: "u1" }, d);
    expect(d.slackLinkedUser).not.toHaveBeenCalled();
    expect(sent[0].to).toBe("founder@acme.test");
  });
});

describe("sendReminderEmail time bound", () => {
  it("gives up on a stalled send and reports send_timeout", async () => {
    const { d } = deps({ send: () => new Promise<void>(() => {}) });
    const t0 = Date.now();
    const r = await sendReminderEmail({ ...BASE, mode: "ping", note: "n" }, d, { timeoutMs: 30 });
    expect(r).toEqual({ sent: false, reason: "send_timeout" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
