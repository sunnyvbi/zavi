import { describe, expect, it } from "vitest";
import { CHANNEL_ACTION_ROW_COLUMNS, toApprovalRow } from "../channel-action-rows";

const raw = {
  id: "a1",
  channel_slug: "blog",
  run_id: "r1",
  position: 1,
  run_of: 2,
  body: { step: { title: "T" } },
  status: "pending",
  proposed_at: "2026-09-24T00:00:00Z",
  exec_class: null,
};

describe("toApprovalRow card presentation", () => {
  it("selects and serves kind, labels, steps and ticks", () => {
    for (const c of ["card_kind", "primary_label", "done_label", "how_to", "steps_done"]) {
      expect(CHANNEL_ACTION_ROW_COLUMNS).toContain(c);
    }
    expect(
      toApprovalRow({ ...raw, card_kind: "plan", primary_label: "Approve plan", done_label: "Approved", how_to: ["Read it"], steps_done: [] }),
    ).toMatchObject({ card_kind: "plan", primary_label: "Approve plan", done_label: "Approved", how_to: ["Read it"], steps_done: [] });
  });
  it("a row with no kind is served as no kind, with empty lists", () => {
    expect(toApprovalRow(raw)).toMatchObject({ card_kind: null, primary_label: null, done_label: null, how_to: [], steps_done: [] });
  });
});

describe("toApprovalRow exec state and money words", () => {
  it("serves exec_status so a queued change is not offered again", () => {
    expect(CHANNEL_ACTION_ROW_COLUMNS).toContain("exec_status");
    expect(toApprovalRow({ ...raw, exec_class: "seo.create_pr.v1", exec_status: "queued" }).exec_status).toBe("queued");
    expect(toApprovalRow(raw).exec_status).toBeNull();
  });
  it("serves a removal stored as Pause as Remove, like the lane", () => {
    const row = toApprovalRow({
      ...raw,
      action_type: "pause_ad",
      exec_class: "google_ads.remove_resource",
      card_kind: "executes",
      primary_label: "Pause",
      done_label: "Done",
      how_to: ["Press Pause. Zavi makes the change in Google Ads."],
    });
    expect(row.primary_label).toBe("Remove");
    expect(row.how_to).toEqual(["Press Remove. Zavi makes the change in Google Ads."]);
  });
});
