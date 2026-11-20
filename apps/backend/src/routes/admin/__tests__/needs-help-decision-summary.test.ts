
import { describe, it, expect } from "vitest";
import { summarizeDecisionBody, buildDecisionDetail } from "../needs-help";

describe("summarizeDecisionBody", () => {
  it("leads with the bet claim for growth-lead drafts, drops n/a from-channel", () => {
    const s = summarizeDecisionBody("growth-lead.lifecycle-draft", {
      bet_claim: "Drop tutor no-show rate below 20%",
      from_channel: "n/a",
      to_channel: "tutor-reliability-program",
      amount_usd: null,
      confidence: "high",
      source_run_id: "x",
    });
    expect(s).toBe(
      "Drop tutor no-show rate below 20% · tutor-reliability-program · confidence high",
    );
    expect(s).not.toContain("n/a");
  });

  it("keeps a real from → to channel shift and amount", () => {
    const s = summarizeDecisionBody("growth-lead.reallocate-budget", {
      bet_claim: "Shift spend to TikTok",
      from_channel: "Google",
      to_channel: "TikTok",
      amount_usd: 200,
      confidence: "medium",
    });
    expect(s).toBe("Shift spend to TikTok · Google → TikTok · $200/wk · confidence medium");
  });

  it("redacts the recipient for send_email", () => {
    const s = summarizeDecisionBody("send_email", {
      to: "jordan@example.com",
      subject: "Weekly advisor brief",
      body_text: "…",
    });
    expect(s).toBe('Send email to jo****@example.com — "Weekly advisor brief"');
    expect(s).not.toContain("jordan@");
  });

  it("summarizes chief-of-staff dispatch + meta-ads budget/status by field presence", () => {
    expect(
      summarizeDecisionBody("chief-of-staff.dispatch-specialist", {
        target_agent_slug: "engineer",
        intent: "fix the broken checkout",
      }),
    ).toBe("Dispatch engineer: fix the broken checkout");

    expect(
      summarizeDecisionBody("meta-ads.update-budget_review", {
        ad_set_id: "123",
        daily_budget_usd: 50,
        rationale: "scale winner",
      }),
    ).toBe("Set ad set 123 daily budget to $50");

    expect(
      summarizeDecisionBody("meta-ads.set-status_review", {
        object_id: "c_9",
        level: "campaign",
        status: "PAUSED",
      }),
    ).toBe("PAUSED campaign c_9");
  });

  it("falls back gracefully on empty/unknown body", () => {
    const fb = "The agent proposed an action that needs your approval before it can run.";
    expect(summarizeDecisionBody("whatever", null)).toBe(fb);
    expect(summarizeDecisionBody("whatever", {})).toBe(fb);
    expect(summarizeDecisionBody("future.class", { rationale: "because reasons" })).toBe(
      "because reasons",
    );
  });
});

describe("buildDecisionDetail", () => {
  it("emits ordered human labels and omits noise + null fields", () => {
    const detail = buildDecisionDetail({
      bet_claim: "Drop no-show rate",
      from_channel: "n/a",
      to_channel: "reliability",
      amount_usd: null,
      confidence: "high",
      rationale: "Churn driver.",
      source_run_id: "x",
      source_signals: [{ memory: "company.live_issues", signal: "y" }],
      amount_qualitative: true,
    });
    const labels = detail.map((d) => d.label);
    expect(labels).toEqual(["Bet", "To channel", "Confidence", "Rationale"]);
    expect(labels).not.toContain("Amount");
    expect(labels).not.toContain("From channel");
    expect(JSON.stringify(detail)).not.toContain("source_run_id");
    expect(JSON.stringify(detail)).not.toContain("source_signals");
  });

  it("redacts recipient and surfaces a future scalar field not in the order list", () => {
    const detail = buildDecisionDetail({ to: "a@b.com", subject: "Hi", extra_note: "kept" });
    const byLabel = Object.fromEntries(detail.map((d) => [d.label, d.value]));
    expect(byLabel["Recipient"]).toBe("a*@b.com");
    expect(byLabel["extra note"]).toBe("kept");
  });

  it("returns [] for a null body", () => {
    expect(buildDecisionDetail(null)).toEqual([]);
  });
});
