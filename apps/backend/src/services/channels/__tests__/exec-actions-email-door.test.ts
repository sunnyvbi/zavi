import { beforeEach, describe, expect, it, vi } from "vitest";

const doors = vi.hoisted(() => ({ ads: vi.fn(async () => false), email: vi.fn(async () => false) }));
vi.mock("@/services/growth/cgo-ads", () => ({ cgoApproveChannelAction: doors.ads }));
vi.mock("@/services/growth/cgo-email", () => ({ cgoApproveEmailChannelAction: doors.email }));

import { reachesCgoAdDoor, recordChannelExecAction } from "../exec-actions";
import { EmitNoWriteError, isNoWriteEmitError } from "@/services/agents/emit-no-write";
import { DecisionEvidenceError } from "@/services/agents/decision-evidence";

const rpc = () => vi.fn(async () => ({ data: { ok: true, id: "act-1", replayed: false }, error: null }));
const off = { enabled: () => false, runMayAct: async () => true };
const emailCard = {
  tenantId: "t-1",
  runId: "r-1",
  channelSlug: "email_marketing",
  execClass: "email_campaign.create_and_send",
  execPayload: { tool: "mailchimp", audience_id: "L1", subject: "Hi" },
  actionType: "send_message" as const,
  title: 'Send "Hi" to Newsletter',
  body: {
    step: { title: "Send", body: "b" },
    exact_change: { rows: [{ item: "Sending with", before: "", after: "Mailchimp" }, { item: "People", before: "", after: "412" }] },
  },
};

beforeEach(() => {
  doors.ads.mockClear();
  doors.email.mockClear();
});

describe("a refusal that wrote nothing is typed as one (G1)", () => {
  it("an explicit {ok:false} from the RPC throws EmitNoWriteError and reaches no door", async () => {
    const r = vi.fn(async () => ({ data: { ok: false, code: "kill_switch" }, error: null }));
    const e = await recordChannelExecAction(emailCard, r as never, off).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EmitNoWriteError);
    expect(isNoWriteEmitError(e)).toBe(true);
    expect(doors.email).not.toHaveBeenCalled();
  });

  it("an RPC error stays ambiguous (a plain Error): the write may have happened", async () => {
    const r = vi.fn(async () => ({ data: null, error: { message: "timeout" } }));
    const e = await recordChannelExecAction(emailCard, r as never, off).catch((x: unknown) => x);
    expect(isNoWriteEmitError(e)).toBe(false);
  });

  it("the emitter's pre-write refusals are no-write: a malformed evidence envelope too", () => {
    expect(isNoWriteEmitError(new DecisionEvidenceError("malformed"))).toBe(true);
    expect(isNoWriteEmitError(new Error("emit_decision failed (x): timeout"))).toBe(false);
  });
});

describe("recordChannelExecAction: the Autopilot door by class", () => {
  it("a stopped run (or killed agent, or an unreadable run) files the card but never reaches the email door", async () => {
    const runMayAct = vi.fn(async () => false);
    const out = await recordChannelExecAction(emailCard, rpc() as never, { ...off, runMayAct });
    expect(out.id).toBe("act-1");
    expect(runMayAct).toHaveBeenCalledWith("t-1", "r-1");
    expect(doors.email).not.toHaveBeenCalled();
  });

  it("an email send card passes the email door, and never the ad door", async () => {
    const r = rpc();
    const out = await recordChannelExecAction(emailCard, r as never, off);
    expect(out.id).toBe("act-1");
    expect(doors.email).toHaveBeenCalledWith("t-1", "act-1", expect.objectContaining({ run_id: "r-1" }));
    expect(doors.ads).not.toHaveBeenCalled();
  });

  it("the card is stored with the button that names how many people it goes to", async () => {
    const r = rpc();
    await recordChannelExecAction(emailCard, r as never, off);
    const action = ((r.mock.calls[0] as unknown[])[2] as { p_action: Record<string, unknown> }).p_action;
    expect(action).toMatchObject({ card_kind: "executes", primary_label: "Send to 412 people", exec_class: "email_campaign.create_and_send" });
    expect(action.exec_payload).toBe(emailCard.execPayload);
  });

  it("an ad change still passes the ad door only", async () => {
    await recordChannelExecAction(
      { tenantId: "t-1", runId: "r-1", channelSlug: "meta_ads", execClass: "meta_ads.set_status", execPayload: { object_id: "1" }, actionType: "pause_ad", title: "Pause", body: { step: { title: "Pause" } } },
      rpc() as never,
      off,
    );
    expect(doors.ads).toHaveBeenCalledWith("t-1", "act-1");
    expect(doors.email).not.toHaveBeenCalled();
  });

  it("a card of any other class passes neither", async () => {
    await recordChannelExecAction(
      { tenantId: "t-1", runId: "r-1", channelSlug: "reddit_ads", execClass: "reddit_ads.set_status", execPayload: { campaign_id: "1" }, actionType: "pause_ad", title: "Pause", body: { step: { title: "Pause" } } },
      rpc() as never,
      off,
    );
    expect(doors.ads).not.toHaveBeenCalled();
    expect(doors.email).not.toHaveBeenCalled();
  });

  it("a card the founder already has (kept) is not sent to a door", async () => {
    const r = vi.fn(async () => ({ data: { ok: true, id: "old-1", kept: true }, error: null }));
    await recordChannelExecAction(emailCard, r as never, off);
    expect(doors.email).not.toHaveBeenCalled();
  });

  it("Reddit: a paused preparation, a launch and a paused replacement reach the ad door (the policy decides each); the grant, budget changes, edits and pauses never do", async () => {
    const card = (execClass: string) => ({ tenantId: "t-1", runId: "r-1", channelSlug: "reddit_ads", execClass, execPayload: { ad_account_id: "a1", operation_key: "op_spring_1" }, actionType: "update_ad" as const, title: "Reddit", body: { step: { title: "Reddit" } } });
    for (const cls of ["reddit_ads.prepare_campaign", "reddit_ads.launch_campaign", "reddit_ads.replace_creative"]) {
      doors.ads.mockClear();
      await recordChannelExecAction(card(cls), rpc() as never, off);
      expect(doors.ads, cls).toHaveBeenCalledWith("t-1", "act-1");
    }
    for (const cls of ["reddit_ads.authorize_account", "reddit_ads.update_budget", "reddit_ads.update_ad", "reddit_ads.update_targeting", "reddit_ads.set_object_status", "reddit_ads.set_status"]) {
      doors.ads.mockClear();
      await recordChannelExecAction(card(cls), rpc() as never, off);
      expect(doors.ads, cls).not.toHaveBeenCalled();
    }
  });

  it("TikTok: a launch is a person's approval, so it never reaches the CGO's door", async () => {
    await recordChannelExecAction(
      { tenantId: "t-1", runId: "r-1", channelSlug: "tiktok_ads", execClass: "tiktok_ads.create_launch", execPayload: { advertiser_id: "1", daily_budget_usd: 25 }, actionType: "create_ad", title: "Launch", body: { step: { title: "Launch" } } },
      rpc() as never,
      off,
    );
    expect(doors.ads).not.toHaveBeenCalled();
    expect(reachesCgoAdDoor("tiktok_ads.create_launch")).toBe(false);
    expect(reachesCgoAdDoor("meta_ads.update_ad_set_budget")).toBe(true);
    expect(reachesCgoAdDoor("linkedin_ads.launch_campaign")).toBe(true);
    expect(reachesCgoAdDoor("linkedin_ads.create_campaign_bundle")).toBe(false);
  });
});
