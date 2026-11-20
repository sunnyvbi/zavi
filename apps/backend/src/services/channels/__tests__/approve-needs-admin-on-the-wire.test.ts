import { describe, expect, it } from "vitest";
import { toActionView } from "../channel-actions";
import { channelApproveNeedsAdmin } from "../approve-needs-admin";

const row = (over: Record<string, unknown>) =>
  ({
    id: "ca-1", channel_slug: "linkedin_ads", run_id: "run-1", position: 1, run_of: 1, blocking: false,
    action_type: "update_ad", title: "Launch LinkedIn campaign Q4", body: {}, status: "pending", note: null,
    snoozed_until: null, impact: null, impact_reason: null, proposed_at: "2026-10-16T00:00:00Z",
    repeat_of: null, redo_of: null, exec_class: "linkedin_ads.launch_campaign", exec_status: null, exec_payload: {}, ...over,
  }) as never;

describe("approve_needs_admin on the wire", () => {
  it("marks a LinkedIn launch and a LinkedIn bundle as owner/admin only", () => {
    expect(toActionView(row({}), 1, {}).approve_needs_admin).toBe(true);
    expect(toActionView(row({ exec_class: "linkedin_ads.create_campaign_bundle", action_type: "create_ad" }), 1, {}).approve_needs_admin).toBe(true);
  });

  it("leaves a LinkedIn pause, a cut and a non-executable card open to members", () => {
    expect(toActionView(row({ exec_class: "linkedin_ads.set_status", action_type: "pause_ad", exec_payload: { status: "PAUSED" } }), 1, {}).approve_needs_admin).not.toBe(true);
    expect(toActionView(row({ channel_slug: "reddit_ads", exec_class: "reddit_ads.update_budget", exec_payload: { expected_current_daily_budget_usd: 20, daily_budget_usd: 10 } }), 1, {}).approve_needs_admin).not.toBe(true);
    expect(toActionView(row({ exec_class: null }), 1, {})).not.toHaveProperty("approve_needs_admin");
  });

  it("agrees with the approve route's gate for every class it serves", () => {
    const cases: Array<[string, unknown]> = [
      ["linkedin_ads.launch_campaign", {}],
      ["linkedin_ads.create_campaign_bundle", {}],
      ["linkedin_ads.set_status", { status: "PAUSED" }],
      ["reddit_ads.launch_campaign", {}],
      ["reddit_ads.set_object_status", { status: "PAUSED" }],
      ["creator.hire", {}],
    ];
    for (const [cls, payload] of cases) {
      expect(toActionView(row({ exec_class: cls, exec_payload: payload }), 1, {}).approve_needs_admin === true, cls).toBe(channelApproveNeedsAdmin(cls, payload));
    }
  });
});
