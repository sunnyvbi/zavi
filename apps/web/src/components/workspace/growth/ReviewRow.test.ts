import { describe, expect, it } from "vitest";
import { decisionButtonLabels, decisionChip, reviewDecisionText, rowWaiting } from "./ReviewRow";

const pm = (body: Record<string, unknown>) => ({ decision_class: "pm.needs_action", handler: "pm.needs_action", body });

describe("reviewDecisionText + buttons (Needs you cards, Ravi 2026-10-18 screenshot)", () => {
  it("a stuck PM retry card leads with the issue and says what Retry does", () => {
    const d = pm({
      theme: "Password hash leaking in API responses + account takeover via profile change",
      exception_kind: "stuck",
      proposed_action: "redispatch_and_close_pr",
      roadmap_id: "r1",
      pr_url: "https://github.com/acme/app/pull/1605",
    });
    const t = reviewDecisionText(d);
    expect(t.title).toBe("Password hash leaking in API responses + account takeover via profile change");
    expect(t.why).toContain("stuck in review");
    expect(t.why).toContain("closes the old PR");
    expect(t.why).not.toMatch(/· stuck|dispatch died/);
    expect(decisionChip(t.agent, d)).toBe("Product PM · You approve");
    expect(decisionButtonLabels(d)).toEqual({ approve: "Retry fix", reject: "Drop it" });
  });

  it("a stuck PM card with no PR never claims a PR is open or will be closed", () => {
    const t = reviewDecisionText(pm({ theme: "Something hung", exception_kind: "stuck", proposed_action: "redispatch_and_close_pr", roadmap_id: "r3", pr_url: null }));
    expect(t.why).toBe("The engineer's fix never finished. Retry starts a fresh attempt.");
    expect(t.why).not.toMatch(/PR/);
  });

  it("a dispatch_died PM card says the job crashed, in plain words", () => {
    const t = reviewDecisionText(
      pm({ theme: "P0 IDOR: authenticated users can read other users' payment methods", exception_kind: "dispatch_died", proposed_action: "redispatch", roadmap_id: "r2" }),
    );
    expect(t.title).toMatch(/^P0 IDOR/);
    expect(t.why).toBe("The engineer job crashed before it produced anything. Retry starts it again.");
  });

  it("the '36 items blocked' heads-up gets one Got it button and says nothing to do", () => {
    const d = pm({ coalesced: true, affected_count: 36, exception_kind: "dispatch_died", proposed_action: "none", roadmap_id: null });
    const t = reviewDecisionText(d);
    expect(t.title).toBe("36 engineer jobs crashed before producing anything");
    expect(t.why).toContain("Nothing for you to do");
    expect(decisionButtonLabels(d)).toEqual({ approve: "Got it", reject: null });
    expect(decisionChip(t.agent, d)).toBe("Product PM · Heads-up");
  });

  it("the stuck rollup only names actions Product PM really offers", () => {
    const t = reviewDecisionText(pm({ stuck_rollup: true, affected_count: 3, proposed_action: "none", roadmap_id: null }));
    expect(t.title).toBe("3 engineer fixes are stuck in review");
    expect(t.why).not.toMatch(/retry|drop/i);
  });

  it("a PM card with no roadmap target is a heads-up even without proposed_action none", () => {
    const d = pm({ theme: "Something", exception_kind: "stuck", roadmap_id: null });
    expect(decisionButtonLabels(d).reject).toBeNull();
    expect(reviewDecisionText(d).why).toBe("Heads-up only. There is nothing to retry.");
  });

  it("other classes keep Approve / Reject and never title the row with the agent name when there is content", () => {
    const d = { decision_class: "operator.file-jira-issue", handler: "jira.create_issue", body: { summary: "Trip 18817: host short-paid $210", rationale: "Host reported it" } };
    const t = reviewDecisionText(d);
    expect(t.title).not.toBe(t.agent);
    expect(decisionButtonLabels(d)).toEqual({ approve: "Approve", reject: "Reject" });
  });
});

describe("database outage card (raised by the data gateway, no handler)", () => {
  const card = {
    decision_class: "operator_db.unreachable",
    handler: null,
    body: { kind: "operator_db_unreachable", outage_started_at: "2026-10-17T21:20:47Z", rationale: "Your database can't be reached", rendered_markdown: "x" },
  };
  it("is a heads-up with one Got it button and its own title", () => {
    expect(decisionButtonLabels(card)).toEqual({ approve: "Got it", reject: null });
    expect(decisionChip("", card)).toBe("Heads-up");
    expect(reviewDecisionText(card).title).toBe("Your database can't be reached");
  });
  it("another handler-less notice still gets Approve / Reject", () => {
    expect(decisionButtonLabels({ handler: null, body: { kind: "something_else" } })).toEqual({ approve: "Approve", reject: "Reject" });
  });
});

describe("rowWaiting (the slip's amber edge on a list row)", () => {
  it("an open approval waits; a heads-up and a decided row do not", () => {
    expect(rowWaiting({ handler: "pm.needs_action", body: { roadmap_id: "r1", proposed_action: "redispatch_and_close_pr" }, status: "proposed" })).toBe(true);
    expect(rowWaiting({ handler: "pm.needs_action", body: { roadmap_id: null }, status: "proposed" })).toBe(false);
    expect(rowWaiting({ handler: "meta_ads.set_status", body: {}, status: "acted" })).toBe(false);
    expect(rowWaiting({ handler: "meta_ads.set_status", body: {}, status: undefined })).toBe(true);
  });
});
