import { describe, expect, it } from "vitest";
import { toActionView } from "../channel-actions";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "ca-1",
    channel_slug: "google_ads",
    run_id: "run-1",
    position: 1,
    run_of: 1,
    blocking: false,
    action_type: "pause_ad",
    title: "Pause 4 keywords with no conversions in 60 days",
    body: { step: { title: "t", body: "b" } },
    status: "open",
    note: null,
    snoozed_until: null,
    impact: null,
    impact_reason: null,
    proposed_at: "2026-09-21T00:00:00Z",
    repeat_of: null,
    redo_of: null,
    ...over,
  } as never;
}

describe("action_label on the wire", () => {
  it("is attached to the served body", () => {
    const v = toActionView(row(), 70, {});
    expect((v.body as { action_label?: string }).action_label).toBe("Pause");
  });

  it("is attached to a row whose body predates this feature", () => {
    const v = toActionView(row({ action_type: "check", title: "Check why mobile signups dropped", body: {} }), 10, {});
    expect((v.body as { action_label?: string }).action_label).toBe("Do it");
  });

  it("reads the exact-change rows the body already carries", () => {
    const v = toActionView(
      row({
        title: "This one is capped",
        action_type: "update_ad",
        body: { exact_change: { rows: [{ item: "Daily budget", before: "$40", after: "$55" }] } },
      }),
      50,
      {},
    );
    expect((v.body as { action_label?: string }).action_label).toBe("Adjust budget");
  });

  it("still strips money_at_stake — attaching a label must not reopen that door", () => {
    const v = toActionView(row({ body: { step: {}, money_at_stake: { usd: 400 } } }), 70, {});
    expect(v.body).not.toHaveProperty("money_at_stake");
    expect((v.body as { action_label?: string }).action_label).toBe("Pause");
  });

  it("leaves a non-object body alone rather than crashing", () => {
    const v = toActionView(row({ body: null }), 70, {});
    expect(v.body).toBeNull();
  });
});

describe("card role on the wire (WS1)", () => {
  it("fills intent and owner for a row written before the writer stored them", () => {
    const v = toActionView(row(), 70, {});
    expect(v.body).toMatchObject({ intent: "improve", owner: "founder" });
    const exec = toActionView(row({ exec_class: "google_ads.set_status" }), 70, {});
    expect(exec.body).toMatchObject({ owner: "zavi" });
  });

  it("keeps a stored role as it is", () => {
    const v = toActionView(row({ body: { step: { title: "t", body: "b" }, intent: "create", owner: "developer" } }), 70, {});
    expect(v.body).toMatchObject({ intent: "create", owner: "developer" });
  });
});

describe("stored card words on the wire", () => {
  const stored = { card_kind: "executes", primary_label: "Pause", done_label: "Done", how_to: ["Check the exact change on this card.", "Press Pause. Zavi makes the change in Google Ads."] };

  it("re-derives a removal stored as Pause from its exec_class, how-to line included", () => {
    const v = toActionView(row({ ...stored, exec_class: "google_ads.remove_resource", title: "Remove the paused test campaign" }), 50, {});
    expect(v.primary_label).toBe("Remove");
    expect(v.how_to[1]).toBe("Press Remove. Zavi makes the change in Google Ads.");
    expect((v.body as { action_label?: string }).action_label).toBe("Remove");
  });

  it("leaves a real pause alone", () => {
    const v = toActionView(row({ ...stored, exec_class: "google_ads.set_status" }), 50, {});
    expect(v.primary_label).toBe("Pause");
    expect(v.how_to[1]).toBe("Press Pause. Zavi makes the change in Google Ads.");
  });

  it("never touches a label that is not one of the fixed ad words", () => {
    const v = toActionView(row({ channel_slug: "seo", action_type: "fix", card_kind: "executes", primary_label: "Open pull request", done_label: "Done", how_to: [], exec_class: "seo.create_pr.v1" }), 50, {});
    expect(v.primary_label).toBe("Open pull request");
  });

  it("marks pull request, video and ad cards approvable on the phone, never an email send or a creator hire", () => {
    expect(toActionView(row({ channel_slug: "seo", exec_class: "seo.create_pr.v1" }), 50, {}).approve_on_phone).toBe(true);
    expect(toActionView(row({ channel_slug: "geo", exec_class: "geo.create_pr.v1" }), 50, {}).approve_on_phone).toBe(true);
    expect(toActionView(row({ channel_slug: "generated_video", exec_class: "generated_video.render.v1" }), 50, {}).approve_on_phone).toBe(true);
    expect(toActionView(row({ exec_class: "google_ads.set_status" }), 50, {}).approve_on_phone).toBe(true);
    expect(toActionView(row({ channel_slug: "email_marketing", exec_class: "email_campaign.create_and_send" }), 50, {}).approve_on_phone).toBeUndefined();
    expect(toActionView(row({ channel_slug: "ugc", exec_class: "creator.hire" }), 50, {}).approve_on_phone).toBeUndefined();
    expect(toActionView(row(), 50, {}).approve_on_phone).toBeUndefined();
  });

  it("an ad card says who may approve it (the approve route's own rule) and the dollars it moves", () => {
    const raise = toActionView(row({ channel_slug: "meta_ads", exec_class: "meta_ads.update_ad_set_budget_review", exec_payload: { ad_set_id: "1", daily_budget_usd: 40, expected_current_daily_budget_usd: 20, rationale: "", over_cap: true } }), 50, {});
    expect(raise.approve_needs_admin).toBe(true);
    expect(raise.approve_money).toEqual({ daily_usd: 20, monthly_usd: 608 });
    const cut = toActionView(row({ channel_slug: "meta_ads", exec_class: "meta_ads.update_ad_set_budget_review", exec_payload: { ad_set_id: "1", daily_budget_usd: 10, expected_current_daily_budget_usd: 20, rationale: "", over_cap: true } }), 50, {});
    expect(cut.approve_needs_admin).toBe(false);
    expect(cut.approve_money).toEqual({ daily_usd: 10, monthly_usd: 304 });
    const pause = toActionView(row({ channel_slug: "meta_ads", exec_class: "meta_ads.set_status_review", exec_payload: { object_id: "1", level: "adset", status: "PAUSED", over_cap: true } }), 50, {});
    expect(pause.approve_needs_admin).toBe(false);
    const resume = toActionView(row({ channel_slug: "meta_ads", exec_class: "meta_ads.set_status_review", exec_payload: { object_id: "1", level: "adset", status: "ACTIVE", over_cap: true } }), 50, {});
    expect(resume.approve_needs_admin).toBe(true);
  });
});
