import { describe, expect, it } from "vitest";
import { toActionView } from "../channel-actions";
import { buildExecCardBody } from "@/services/tools/google-ads/write/_exec-action";
import { toApprovalRow } from "@/routes/approvals/channel-action-rows";
import { channelCardNoteItem } from "@/services/growth/cgo-note-items";

const MODEL_HEADLINE = "Let the campaign that books spend the extra $10 a day";
const RAISE = {
  campaign_id: "24109304360",
  name: "Search A",
  verified_name: "Search A",
  daily_budget_usd: 120,
  expected_current_daily_budget_usd: 110,
  rationale: "13 purchases at $65 each.",
  over_cap: true,
  decision_evidence: { headline: MODEL_HEADLINE, reason_text: "13 purchases at $65 each." },
};
const HEADLINE = "Raise “Search A” from $110 to $120 a day";

const row = (over: Record<string, unknown>) =>
  ({
    id: "ca-1", channel_slug: "google_ads", run_id: "run-1", position: 1, run_of: 1, blocking: false,
    action_type: "update_ad", title: MODEL_HEADLINE, body: { step: { title: MODEL_HEADLINE, body: "x" } }, status: "pending", note: null,
    snoozed_until: null, impact: null, impact_reason: null, proposed_at: "2026-10-17T00:00:00Z",
    repeat_of: null, redo_of: null, ...over,
  }) as never;

describe("a budget card's title is the server's", () => {
  it("write time: the Google exec card ignores the model's headline for a budget change", () => {
    const { title, card } = buildExecCardBody("google_ads.update_campaign_budget_review", RAISE);
    expect(title).toBe(HEADLINE);
    expect((card.step as { title: string }).title).toBe(HEADLINE);
    expect((card.decision_evidence as { headline: string }).headline).toBe(MODEL_HEADLINE);
  });

  it("must not touch: a keyword card keeps the model's headline", () => {
    const { title } = buildExecCardBody("google_ads.add_keywords", {
      campaign_id: "1",
      keywords: [{ text: "rival", match_type: "PHRASE", negative: true }],
      rationale: "r",
      decision_evidence: { headline: "Block searches for a rival brand" },
    });
    expect(title).toBe("Block searches for a rival brand");
  });

  it("read time: a row written with the model's title serves the server's, title and step title", () => {
    const v = toActionView(row({ exec_class: "google_ads.update_campaign_budget_review", exec_payload: RAISE }), 1, {}) as unknown as { title: string; body: { step: { title: string; body: string } } };
    expect(v.title).toBe(HEADLINE);
    expect(v.body.step.title).toBe(HEADLINE);
    expect(v.body.step.body).toBe("x");
    expect(JSON.stringify(v)).not.toContain(MODEL_HEADLINE);
  });

  it("a legacy row with no platform name shows the agent's name beside the id", () => {
    const { verified_name: _v, ...legacy } = RAISE;
    void _v;
    const v = toActionView(row({ exec_class: "google_ads.update_campaign_budget_review", exec_payload: legacy }), 1, {}) as unknown as { title: string };
    expect(v.title).toBe("Raise “Search A” (campaign 24109304360) from $110 to $120 a day");
  });

  it("must not touch: a recipe card with no exec class keeps its own title", () => {
    const v = toActionView(row({ title: "Post a reel", body: { step: { title: "Post a reel" } } }), 1, {}) as unknown as { title: string };
    expect(v.title).toBe("Post a reel");
  });

  it("the approvals list row (Channels panel) serves the server's step title and never the payload", () => {
    const r = toApprovalRow({
      id: "ca-1", channel_slug: "google_ads", run_id: "run-1", position: 1, run_of: 1,
      body: { step: { title: MODEL_HEADLINE } }, status: "pending", proposed_at: "2026-10-17T00:00:00Z",
      exec_class: "google_ads.update_campaign_budget_review", exec_payload: RAISE,
    });
    expect((r.body as { step: { title: string } }).step.title).toBe(HEADLINE);
    expect(JSON.stringify(r)).not.toContain("24109304360");
  });

  it("the cgo note line names the change, not cgo's or the card's prose", () => {
    const item = channelCardNoteItem({
      outcome: "leave",
      row: { id: "ca-1", channel_slug: "google_ads", title: MODEL_HEADLINE, exec_class: "google_ads.update_campaign_budget_review", exec_payload: RAISE },
      bucket: null,
      action: "Let the booking campaign spend more",
      why: "it books",
      usd: null,
      platform: "Google Ads",
      fixText: null,
    });
    expect(item.text).toBe(HEADLINE);
  });
});
