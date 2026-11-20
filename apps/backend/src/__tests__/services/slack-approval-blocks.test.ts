import { describe, it, expect } from "vitest";
import {
  buildApprovalBlocks,
  buildApprovalFallbackText,
  SLACK_ACTION_APPROVE,
  SLACK_ACTION_REJECT,
} from "../../services/approvals/slack-approval-blocks";

const DECISION = "20000000-0000-0000-0000-000000000099";

function actionsBlock(blocks: unknown[]): { elements: Array<Record<string, unknown>> } {
  return blocks.find((b) => (b as { type?: string }).type === "actions") as {
    elements: Array<Record<string, unknown>>;
  };
}

describe("buildApprovalBlocks", () => {
  it("renders approve/reject buttons carrying the decision_id + action_ids", () => {
    const blocks = buildApprovalBlocks({ id: DECISION, decision_class: "engineer.ship-pr", body: {} });
    const actions = actionsBlock(blocks);
    const approve = actions.elements.find((e) => e.action_id === SLACK_ACTION_APPROVE);
    const reject = actions.elements.find((e) => e.action_id === SLACK_ACTION_REJECT);
    expect(approve?.value).toBe(DECISION);
    expect(reject?.value).toBe(DECISION);
  });

  it("renders the C-1 decision_evidence (reason, blast radius, confidence, evidence)", () => {
    const blocks = buildApprovalBlocks({
      id: DECISION,
      decision_class: "browser.action",
      body: {
        decision_evidence: {
          reason_text: "Posting the launch tweet now hits peak engagement.",
          evidence: ["GA shows 6pm PT peak", "competitor posted 5m ago"],
          alternatives_considered: ["wait until tomorrow"],
          reversibility: "reversible_with_cost",
          blast_radius: "ORANGE",
          confidence: 0.82,
        },
      },
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain("Posting the launch tweet now");
    expect(text).toContain("ORANGE");
    expect(text).toContain("82%");
    expect(text).toContain("reversible with cost");
    expect(text).toContain("GA shows 6pm PT peak");
    expect(text).toContain("wait until tomorrow");
  });

  it("degrades to a valid header + buttons when evidence is absent", () => {
    const blocks = buildApprovalBlocks({ id: DECISION, decision_class: null, body: null });
    expect((blocks[0] as { type: string }).type).toBe("header");
    expect(actionsBlock(blocks).elements.length).toBe(2);
    expect(JSON.stringify(blocks)).toContain("No structured evidence");
  });

  it("degrades when decision_evidence is malformed (no throw)", () => {
    const blocks = buildApprovalBlocks({
      id: DECISION,
      decision_class: "x",
      body: { decision_evidence: { reason_text: "", blast_radius: "PURPLE" } },
    });
    expect(actionsBlock(blocks).elements.length).toBe(2);
  });

  it("fallback text is human-readable (title, not a raw UUID)", () => {
    const fb = buildApprovalFallbackText({ id: DECISION, decision_class: "x", body: {} });
    expect(fb).toContain("Approval needed");
    expect(fb).not.toContain(DECISION);
  });

  it("ads classes get a 'Manage ads autopilot →' LINK-OUT (url button), NOT an inline always-allow", () => {
    for (const cls of [
      "meta_ads.update_ad_set_budget",
      "google_ads.set_status_review",
    ]) {
      const blocks = buildApprovalBlocks({ id: DECISION, decision_class: cls, body: {} });
      const actions = actionsBlock(blocks);
      const link = actions.elements.find(
        (e) =>
          typeof e.url === "string" &&
          String((e.text as { text?: string })?.text).includes("Manage ads autopilot"),
      );
      expect(link, `link-out present for ${cls}`).toBeTruthy();
      expect(link?.action_id).toBeUndefined();
      const alwaysAllow = actions.elements.find((e) => e.action_id === "praxis_approve_always");
      expect(alwaysAllow, `no inline always-allow for ${cls}`).toBeUndefined();
      expect(actions.elements.find((e) => e.action_id === SLACK_ACTION_APPROVE)).toBeTruthy();
      expect(actions.elements.find((e) => e.action_id === SLACK_ACTION_REJECT)).toBeTruthy();
    }
  });

  it("non-ads class gets NO link-out button", () => {
    const blocks = buildApprovalBlocks({ id: DECISION, decision_class: "engineer.ship-pr", body: {} });
    const actions = actionsBlock(blocks);
    expect(actions.elements.find((e) => typeof e.url === "string")).toBeUndefined();
  });
});

describe("Approve value carries a staged post's time (social.publish.v2 only)", () => {
  const load = () => import("@/services/approvals/slack-approval-blocks");
  const social = (scheduled_at: unknown) => ({
    id: "d1",
    decision_class: "social.publish.v2",
    body: { channel: "x", payload: { text: "hi" }, scheduled_at },
  });

  it("round-trips the rendered time, and an empty one as null", async () => {
    const { buildApproveValue, parseApproveValue } = await load();
    expect(parseApproveValue(buildApproveValue(social("2099-01-02T09:00:00Z")))).toEqual({
      decisionId: "d1",
      expected_scheduled_at: "2099-01-02T09:00:00Z",
    });
    expect(parseApproveValue(buildApproveValue(social(null)))).toEqual({ decisionId: "d1", expected_scheduled_at: null });
  });

  it("every other class, and a bare id, keep the plain decision id", async () => {
    const { buildApproveValue, parseApproveValue } = await load();
    expect(buildApproveValue({ id: "d2", decision_class: "meta_ads.set_status", body: { scheduled_at: "x" } })).toBe("d2");
    expect(parseApproveValue("d2")).toEqual({ decisionId: "d2" });
  });

  it("both Approve buttons on a social card carry it; Reject does not", async () => {
    const { buildApprovalBlocks } = await load();
    const blocks = buildApprovalBlocks({ ...social("2099-01-02T09:00:00Z"), click_allowlistable: true }) as Array<{
      type: string;
      elements?: Array<{ action_id?: string; value?: string }>;
    }>;
    const els = blocks.find((b) => b.type === "actions")?.elements ?? [];
    const byId = Object.fromEntries(els.filter((e) => e.action_id).map((e) => [e.action_id, e.value]));
    expect(byId.praxis_approve).toBe("d1|sa=2099-01-02T09:00:00Z");
    expect(byId.praxis_approve_always).toBe("d1|sa=2099-01-02T09:00:00Z");
    expect(byId.praxis_reject).toBe("d1");
  });
});

describe("a social card shows every field that publishes, not just the copy", () => {
  it("a Pinterest pin shows its title, board and full destination link", async () => {
    const { buildApprovalBlocks } = await import("@/services/approvals/slack-approval-blocks");
    const blocks = buildApprovalBlocks({
      id: "d3",
      decision_class: "social.publish.v2",
      body: {
        channel: "pinterest_pin",
        payload: { text: "Stonewashed linen.", title: "Linen duvet cover", board_name: "Linen bedding", link: "https://acme.com/p/duvet?x=1" },
        scheduled_at: null,
      },
    });
    const all = JSON.stringify(blocks);
    expect(all).toContain("*Title*\\nLinen duvet cover");
    expect(all).toContain("*Board*\\nLinen bedding");
    expect(all).toContain("*Link*\\nhttps://acme.com/p/duvet?x=1");
  });
});
