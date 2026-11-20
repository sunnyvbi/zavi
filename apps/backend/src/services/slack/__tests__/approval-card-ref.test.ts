
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const maybeSingle = vi.fn();
const slackFetch = vi.fn();

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc,
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }),
      }),
    }),
  }),
}));

vi.mock("@/services/tools/slack/_client", () => ({
  slackFetch: (...a: unknown[]) => slackFetch(...a),
}));

vi.mock("@/services/slack/resolve-zavi-channel", () => ({
  resolveZaviChannel: vi.fn(async () => "C_ZAVI"),
}));

import {
  recordApprovalCardRef,
  getApprovalCardRef,
  updateApprovalCard,
  SLACK_APPROVAL_CARD_SURFACE,
} from "../approval-post-target";

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: null, error: null });
  maybeSingle.mockReset();
  slackFetch.mockReset();
});

describe("recordApprovalCardRef — a ref means WE POSTED A CARD", () => {
  it("writes the ref under the card surface, distinct from the dispatch-notice surface", async () => {
    await recordApprovalCardRef({
      decision_id: "d1",
      tenant_id: "t1",
      channel_id: "C1",
      ts: "1752.100",
      team_id: "T1",
      card_text: "Approve?",
    });
    expect(rpc).toHaveBeenCalledWith(
      "upsert_dispatch_notice_ref",
      expect.objectContaining({
        p_decision_id: "d1",
        p_surface: SLACK_APPROVAL_CARD_SURFACE,
        p_tenant_id: "t1",
        p_slack_channel_id: "C1",
        p_slack_ts: "1752.100",
      }),
    );
    expect(SLACK_APPROVAL_CARD_SURFACE).not.toBe("slack");
  });

  it("does NOT write a ref when Slack returned no ts (nothing to edit later)", async () => {
    await recordApprovalCardRef({ decision_id: "d1", tenant_id: "t1", channel_id: "C1", ts: "" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("never throws when the RPC fails — a ref write must not fail the card post", async () => {
    rpc.mockRejectedValue(new Error("boom"));
    await expect(
      recordApprovalCardRef({ decision_id: "d1", tenant_id: "t1", channel_id: "C1", ts: "1.0" }),
    ).resolves.toBeUndefined();
  });
});

describe("getApprovalCardRef — D1: no card posted ⇒ no ref ⇒ caller stays silent", () => {
  it("returns null when no ref row exists (e.g. a web-chat-origin decision)", async () => {
    maybeSingle.mockResolvedValue({ data: null });
    expect(await getApprovalCardRef("d1", "t1")).toBeNull();
  });

  it("returns null when the row exists but carries no ts", async () => {
    maybeSingle.mockResolvedValue({ data: { slack_channel_id: "C1", slack_ts: null } });
    expect(await getApprovalCardRef("d1", "t1")).toBeNull();
  });

  it("returns the channel+ts when we really did post a card", async () => {
    maybeSingle.mockResolvedValue({
      data: { slack_channel_id: "C1", slack_ts: "1752.100", slack_team_id: "T1" },
    });
    expect(await getApprovalCardRef("d1", "t1")).toEqual({
      channel_id: "C1",
      ts: "1752.100",
      team_id: "T1",
    });
  });

  it("never throws on a DB error — returns null (fail quiet, never fail the dispatch)", async () => {
    maybeSingle.mockRejectedValue(new Error("db down"));
    expect(await getApprovalCardRef("d1", "t1")).toBeNull();
  });
});

describe("updateApprovalCard — D2: the outcome lands on the exact card", () => {
  it("chat.updates the recorded channel+ts with the tenant's team token", async () => {
    slackFetch.mockResolvedValue({ ok: true });
    const ok = await updateApprovalCard({
      tenant_id: "t1",
      ref: { channel_id: "C1", ts: "1752.100", team_id: "T1" },
      text: "✅ Done.",
    });
    expect(ok).toBe(true);
    expect(slackFetch).toHaveBeenCalledWith(
      "t1",
      "chat.update",
      { channel: "C1", ts: "1752.100", text: "✅ Done." },
      "T1",
    );
  });

  it("reports false (not a throw) when Slack refuses the edit", async () => {
    slackFetch.mockResolvedValue({ ok: false, error: "message_not_found" });
    expect(
      await updateApprovalCard({ tenant_id: "t1", ref: { channel_id: "C1", ts: "1.0" }, text: "x" }),
    ).toBe(false);
  });

  it("reports false (not a throw) when the Slack call itself blows up", async () => {
    slackFetch.mockRejectedValue(new Error("network"));
    expect(
      await updateApprovalCard({ tenant_id: "t1", ref: { channel_id: "C1", ts: "1.0" }, text: "x" }),
    ).toBe(false);
  });
});
