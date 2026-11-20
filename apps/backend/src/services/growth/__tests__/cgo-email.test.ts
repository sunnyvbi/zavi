import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeMailchimp, type FakeTool } from "@/services/connectors/email-campaign/__tests__/fake-tools";

const m = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  notes: [] as Array<Record<string, unknown>>,
  inserted: [] as Array<Record<string, unknown>>,
  rpc: vi.fn(),
  send: vi.fn(),
  authorize: vi.fn(),
  owner: "owner-1" as string | null,
  resolve: vi.fn(),
  exec: vi.fn(),
  planned: { data: [] as Array<{ id: string }>, error: null as { message: string } | null },
  plannedFilters: [] as Array<[string, unknown]>,
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (...a: unknown[]) => m.rpc(...a),
  tenantClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let containsKey: string | null = null;
      let inserting = false;
      for (const k of ["select", "eq", "order", "in", "gt"]) {
        q[k] = (a: string, b: unknown) => {
          if (table === "email_planned_sends") m.plannedFilters.push([a, b]);
          return q;
        };
      }
      q.contains = (_c: string, v: string[]) => ((containsKey = v[0]), q);
      q.insert = (r: Record<string, unknown>) => ((inserting = true), m.inserted.push(r), q);
      q.limit = () => (table === "email_planned_sends" ? Promise.resolve(m.planned) : containsKey ? Promise.resolve({ data: m.notes.filter((n) => (n.alarm_keys as string[]).includes(containsKey as string)), error: null }) : q);
      q.maybeSingle = async () => {
        if (table === "channel_actions") return { data: m.row, error: null };
        if (inserting) {
          const note = { id: `note-${m.inserted.length}`, ...m.inserted[m.inserted.length - 1] };
          m.notes.push(note);
          return { data: { id: note.id }, error: null };
        }
        return { data: { next_review_at: "2026-10-10T00:00:00Z" }, error: null };
      };
      return q;
    },
  }),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: (...a: unknown[]) => m.send(...a) } }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("../cgo-auto-run", () => ({ tenantOwnerId: async () => m.owner }));
vi.mock("../unattended-email", async (orig) => ({
  ...(await orig<typeof import("../unattended-email")>()),
  authorizeUnattendedEmail: (...a: unknown[]) => m.authorize(...a),
}));
vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: (...a: unknown[]) => m.resolve(...a) }));
vi.mock("@/services/connectors/composio/api", () => ({ composioExecuteTool: (...a: unknown[]) => m.exec(...a) }));

import { autopilotSendLine, cgoApproveEmailChannelAction, notifyFounderOfAutopilotSend } from "../cgo-email";
import { evaluateUnattendedEmail } from "../unattended-email";

const ACTION = "22222222-2222-4222-8222-222222222222";
const payload = {
  tool: "mailchimp", connected_account_id: "ca-1", auth_config_id: "ac-1", audience_id: "L1", audience_name: "Newsletter", audience_count: 800,
  subject: "Spring offer", preview_text: null, body_text: "x", from_name: "Acme", from_email: "hi@acme.test", reply_to: null,
};
const card = (over: Record<string, unknown> = {}) => ({
  channel_slug: "email_marketing", exec_class: "email_campaign.create_and_send", exec_payload: payload, exec_status: null, status: "pending", approved_by_source: null, ...over,
});
let mc: FakeTool;

beforeEach(() => {
  for (const f of [m.rpc, m.send, m.authorize, m.resolve, m.exec]) f.mockReset();
  m.notes = [];
  m.inserted = [];
  m.planned = { data: [], error: null };
  m.plannedFilters = [];
  m.owner = "owner-1";
  m.row = card();
  mc = fakeMailchimp([{ id: "L1", name: "Newsletter", members: 800 }]);
  m.resolve.mockResolvedValue({ tenant_id: "t1", toolkit: "mailchimp", connected_account_id: "ca-1", auth_config_id: "ac-1" });
  m.exec.mockImplementation((c: Parameters<FakeTool["exec"]>[0]) => mc.exec(c));
  m.authorize.mockResolvedValue({ verdict: "allow", reasons: [] });
  m.rpc.mockResolvedValue({ data: { ok: true, replayed: false, attempt: 1 }, error: null });
  m.send.mockResolvedValue(undefined);
});

describe("cgoApproveEmailChannelAction checks the sender at the door too", () => {
  it("a card whose sender is not the tool's default is never approved by Autopilot", async () => {
    m.row = card({ exec_payload: { ...payload, from_name: "Someone Else" } });
    expect(await cgoApproveEmailChannelAction("t1", ACTION)).toBe(false);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });

  it("the default sender: approved", async () => {
    expect(await cgoApproveEmailChannelAction("t1", ACTION)).toBe(true);
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });
});

describe("the door and a list with a planned email coming", () => {
  it("must catch: a chat redraft that lost its plan binding is left for the founder, with no count, no approval and no event", async () => {
    m.planned = { data: [{ id: "item-1" }], error: null };
    expect(await cgoApproveEmailChannelAction("t1", ACTION)).toBe(false);
    expect(m.authorize).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
    expect(m.plannedFilters).toEqual(expect.arrayContaining([["list_key", "mailchimp:L1"], ["tenant_id", "t1"]]));
    expect(m.plannedFilters.find(([k]) => k === "status")?.[1]).toEqual(["planned", "drafting", "ready", "scheduled"]);
  });

  it("a plan read that fails leaves the card for the founder (fail closed)", async () => {
    m.planned = { data: [], error: { message: "down" } };
    expect(await cgoApproveEmailChannelAction("t1", ACTION)).toBe(false);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });

  it("control: no planned email on the list: approved as before", async () => {
    expect(await cgoApproveEmailChannelAction("t1", ACTION)).toBe(true);
    expect(m.send).toHaveBeenCalledTimes(1);
  });
});

describe("cgoApproveEmailChannelAction", () => {
  it("a Stop pressed during the list count wins: Stop is read again right before the approval", async () => {
    const reads: string[] = [];
    const mayAct = vi.fn(async () => {
      reads.push(m.rpc.mock.calls.length === 0 ? "before-approve" : "after");
      return false;
    });
    expect(await cgoApproveEmailChannelAction("t1", ACTION, { run_id: "run-1", mayAct })).toBe(false);
    expect(m.authorize).toHaveBeenCalled();
    expect(mayAct).toHaveBeenCalledWith("t1", "run-1");
    expect(reads).toEqual(["before-approve"]);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });

  it("a live run is approved as before", async () => {
    expect(await cgoApproveEmailChannelAction("t1", ACTION, { run_id: "run-1", mayAct: async () => true })).toBe(true);
    expect(m.rpc).toHaveBeenCalled();
  });

  it("must catch R1: a planned draft filed with Autopilot and Auto send on is never approved at birth (no count read, no RPC, no event)", async () => {
    m.row = card({ exec_payload: { ...payload, planned_send_id: "11111111-1111-4111-8111-111111111111", plan_version: 1 } });
    expect(await cgoApproveEmailChannelAction("t1", ACTION)).toBe(false);
    expect(m.authorize).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
    expect(mc.calls).toEqual([]);
  });

  it("allowed: approves through the locked RPC as cgo and fires the same event a founder's Approve fires", async () => {
    expect(await cgoApproveEmailChannelAction("t1", ACTION)).toBe(true);
    expect(m.rpc).toHaveBeenCalledWith("t1", "approve_email_campaign_send_as_cgo", { p_action_id: ACTION, p_event_key: `cgo:${ACTION}`, p_actor_user_id: "owner-1", p_approved_count: 800 });
    expect(m.send).toHaveBeenCalledWith({ id: `approve:${ACTION}:1`, name: "channel-action.approved", data: { action_id: ACTION } });
  });

  it("the gate is given the list size read from the tool just now, not the size on the card", async () => {
    mc.lists[0].members = 1001;
    await cgoApproveEmailChannelAction("t1", ACTION);
    expect(m.authorize.mock.calls[0][1]).toMatchObject({ action_id: ACTION, exec_class: "email_campaign.create_and_send", audience_count: 1001 });
    expect(m.authorize.mock.calls[0][2]).toEqual({ where: "door" });
  });

  it("the gate says ask the founder: nothing is approved and the card stays pending", async () => {
    m.authorize.mockResolvedValue({ verdict: "ask_founder", reasons: ["audience_over_limit"] });
    expect(await cgoApproveEmailChannelAction("t1", ACTION)).toBe(false);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });

  describe("the connected account is not the one the card was made on", () => {
    const connectedAs = (connected_account_id: string, tool: FakeTool) => {
      m.resolve.mockResolvedValue({ tenant_id: "t1", toolkit: "mailchimp", connected_account_id, auth_config_id: "ac-1" });
      m.exec.mockImplementation((c: Parameters<FakeTool["exec"]>[0]) => tool.exec(c));
      m.authorize.mockImplementation(async (_t: string, a: { audience_count: number | null }) =>
        evaluateUnattendedEmail({ autopilot_on: true, channel_autorun_on: true, audience_count: a.audience_count, cgo_sent_to_audience_within_7d: false }),
      );
    };

    it("a reconnect of the same account (new connection id, same list): the list is read through the new connection and the send is approved", async () => {
      connectedAs("ca-new", mc);
      expect(await cgoApproveEmailChannelAction("t1", ACTION)).toBe(true);
      expect(m.authorize.mock.calls[0][1]).toMatchObject({ audience_count: 800 });
      expect(mc.calls.length).toBeGreaterThan(0);
      expect(mc.calls.every((c) => c.connected_account_id === "ca-new")).toBe(true);
      expect(m.rpc.mock.calls[0][2]).toMatchObject({ p_approved_count: 800 });
      expect(m.send).toHaveBeenCalledTimes(1);
    });

    it("another account that does not hold the list: the gate is told the size is unknown, never the card's 800, and nothing is approved", async () => {
      const other = fakeMailchimp([{ id: "L9", name: "Their customers", members: 300 }]);
      connectedAs("ca-other", other);
      expect(await cgoApproveEmailChannelAction("t1", ACTION)).toBe(false);
      expect(m.authorize.mock.calls[0][1]).toMatchObject({ audience_count: null });
      expect(mc.calls).toEqual([]);
      expect(m.rpc).not.toHaveBeenCalled();
      expect(m.send).not.toHaveBeenCalled();
    });

    it("another account answering the same list id under another name: the size is unknown and nothing is approved", async () => {
      const other = fakeMailchimp([{ id: "L1", name: "Their customers", members: 300 }]);
      connectedAs("ca-other", other);
      expect(await cgoApproveEmailChannelAction("t1", ACTION)).toBe(false);
      expect(m.authorize.mock.calls[0][1]).toMatchObject({ audience_count: null });
      expect(m.rpc).not.toHaveBeenCalled();
      expect(m.send).not.toHaveBeenCalled();
    });
  });

  it("the RPC refuses because another cgo run just sent to this list: left for the founder, no event", async () => {
    m.rpc.mockResolvedValue({ data: { ok: false, code: "cgo_email_sent_recently" }, error: null });
    expect(await cgoApproveEmailChannelAction("t1", ACTION)).toBe(false);
    expect(m.send).not.toHaveBeenCalled();
  });

  const untouched: Array<[string, Record<string, unknown>]> = [
    ["a card on another channel", { channel_slug: "meta_ads" }],
    ["an ad class", { exec_class: "meta_ads.set_status" }],
    ["a card that already failed once", { exec_status: "failed" }],
    ["a card the founder already approved", { exec_status: "queued", approved_by_source: null }],
    ["a card that is no longer pending", { status: "rejected" }],
  ];
  for (const [name, over] of untouched) {
    it(`${name} is never approved here`, async () => {
      m.row = card(over);
      expect(await cgoApproveEmailChannelAction("t1", ACTION)).toBe(false);
      expect(m.rpc).not.toHaveBeenCalled();
    });
  }

  it("no owner to approve as: left for the founder", async () => {
    m.owner = null;
    expect(await cgoApproveEmailChannelAction("t1", ACTION)).toBe(false);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("cgo's own approval whose event was lost is re-sent with the same id, without judging it twice", async () => {
    m.row = card({ exec_status: "queued", approved_by_source: "cgo" });
    m.rpc.mockResolvedValue({ data: { ok: true, replayed: true, attempt: 1, exec_status: "queued" }, error: null });
    expect(await cgoApproveEmailChannelAction("t1", ACTION)).toBe(true);
    expect(m.authorize).not.toHaveBeenCalled();
    expect(m.send).toHaveBeenCalledWith(expect.objectContaining({ id: `approve:${ACTION}:1` }));
  });

  it("an approval that committed but whose event could not be sent throws, so the caller retries", async () => {
    m.send.mockRejectedValue(new Error("queue down"));
    await expect(cgoApproveEmailChannelAction("t1", ACTION)).rejects.toThrow("queue down");
  });
});

describe("telling the founder what Autopilot sent", () => {
  const sent = { action_id: ACTION, tool: "mailchimp", subject: "Spring offer", audience_name: "Newsletter", sent_to: 800, url: "https://admin.mailchimp.com/campaigns/show/?id=9000" };

  it("says what was sent, to how many people, on which list, in which tool, with the link", () => {
    expect(autopilotSendLine(sent)).toBe('Autopilot sent "Spring offer" to 800 people on your "Newsletter" list in Mailchimp. See it: https://admin.mailchimp.com/campaigns/show/?id=9000');
    expect(autopilotSendLine({ ...sent, sent_to: 1, url: null })).toBe('Autopilot sent "Spring offer" to 1 person on your "Newsletter" list in Mailchimp.');
  });

  it("writes one note and emails it", async () => {
    expect(await notifyFounderOfAutopilotSend("t1", sent)).toBe(true);
    expect(m.inserted).toEqual([expect.objectContaining({ tenant_id: "t1", kind: "alarm", run_id: null, changed: [autopilotSendLine(sent)], alarm_keys: [`email_sent:${ACTION}`] })]);
    expect(m.send).toHaveBeenCalledWith({ id: "cgo-note-email:note:note-1", name: "cgo/note.email", data: { note_id: "note-1", tenant_id: "t1" } });
  });

  it("a second report of the same send writes no second note, and re-sends the same email event (deduped)", async () => {
    await notifyFounderOfAutopilotSend("t1", sent);
    expect(await notifyFounderOfAutopilotSend("t1", sent)).toBe(false);
    expect(m.inserted).toHaveLength(1);
    expect(m.send).toHaveBeenCalledTimes(2);
    expect(m.send.mock.calls[1][0]).toEqual(m.send.mock.calls[0][0]);
  });

  it("the note was written but its email event failed: the call throws, and the next call sends the email for that same note", async () => {
    m.send.mockRejectedValueOnce(new Error("queue down"));
    await expect(notifyFounderOfAutopilotSend("t1", sent)).rejects.toThrow("queue down");
    expect(m.inserted).toHaveLength(1);
    await notifyFounderOfAutopilotSend("t1", sent);
    expect(m.inserted).toHaveLength(1);
    expect(m.send).toHaveBeenLastCalledWith({ id: "cgo-note-email:note:note-1", name: "cgo/note.email", data: { note_id: "note-1", tenant_id: "t1" } });
  });
});
