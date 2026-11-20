import { describe, it, expect } from "vitest";
import { buildApprovalBlocks, capFieldValue } from "../slack-approval-blocks";

function flatText(blocks: unknown[]): string {
  return JSON.stringify(blocks);
}

describe("buildApprovalBlocks — meta_ads body detail (no decision_evidence)", () => {
  it("budget_review: shows name, $old→$new, rationale, about — NOT 'No structured evidence'", () => {
    const blocks = buildApprovalBlocks({
      id: "d1",
      decision_class: "meta_ads.update_ad_set_budget_review",
      body: {
        name: "Upcar host - Copy — Host ad set",
        about: "Ad set inside Upcar host - Copy campaign. Paused since May 21.",
        rationale: "Founder-directed probe budget $10/day (was $40/day, reducing). 0 purchases historically.",
        over_cap: true,
        daily_budget_usd: 10,
        expected_current_daily_budget_usd: 40,
      },
    });
    const s = flatText(blocks);
    expect(s).not.toContain("No structured evidence");
    expect(s).toContain("Upcar host - Copy");
    expect(s).toContain("$40/day → $10/day");
    expect(s).toContain("Founder-directed probe");
    expect(s).not.toContain("Over your configured cap");
    expect(s).toContain("praxis_approve");
    expect(s).toContain("praxis_reject");
  });

  it("set_status PAUSED: shows 'Pause <name>' + new status + rationale", () => {
    const blocks = buildApprovalBlocks({
      id: "d2",
      decision_class: "meta_ads.set_status_review",
      body: {
        name: "Gig Leads - Ad set",
        level: "adset",
        status: "PAUSED",
        rationale: "30d: 0 purchases on $58 spend = ROAS 0×.",
        about: "Lead-objective clone targeting gig drivers.",
      },
    });
    const s = flatText(blocks);
    expect(s).not.toContain("No structured evidence");
    expect(s).toContain("Pause");
    expect(s).toContain("Gig Leads - Ad set");
    expect(s).toContain("PAUSED");
    expect(s).toContain("ROAS 0×");
  });

  it("set_status ACTIVE: shows 'Activate <name>'", () => {
    const blocks = buildApprovalBlocks({
      id: "d3",
      decision_class: "meta_ads.set_status_review",
      body: { name: "Bay Area Rentals", status: "ACTIVE", rationale: "Strong ROAS." },
    });
    expect(flatText(blocks)).toContain("Activate");
    expect(flatText(blocks)).toContain("Bay Area Rentals");
  });

  it("a meta_ads decision WITH a decision_evidence envelope keeps the envelope rendering (unchanged)", () => {
    const blocks = buildApprovalBlocks({
      id: "d4",
      decision_class: "meta_ads.update_ad_set_budget_review",
      body: {
        decision_evidence: {
          reason_text: "Envelope reason wins when present",
          evidence: ["x"],
          alternatives_considered: [],
          reversibility: "reversible",
          blast_radius: "YELLOW",
          confidence: 0.7,
        },
        name: "should-not-need-this",
        daily_budget_usd: 10,
      },
    });
    expect(flatText(blocks)).toContain("Envelope reason wins when present");
  });

  it("non-meta_ads with no evidence still shows the generic fallback", () => {
    const blocks = buildApprovalBlocks({ id: "d5", decision_class: "growth-lead.lifecycle-draft", body: {} });
    expect(flatText(blocks)).toContain("No structured evidence");
  });
});

describe("capFieldValue — the cap line says why, never 'over cap' for a cut", () => {
  const cut = { over_cap: true, daily_budget_usd: 10, expected_current_daily_budget_usd: 20 };
  const raise = { over_cap: true, daily_budget_usd: 50, expected_current_daily_budget_usd: 40 };

  it("a cut with no cap configured names the missing limit, not an exceeded one", () => {
    expect(capFieldValue({ ...cut, cap_reason: "no_cap_configured" })).toBe("No spend limit is set, so this waits for your approval");
    expect(capFieldValue({ ...cut, cap_reason: "cap_disabled" })).toBe("Spend limits are off, so this waits for your approval");
  });

  it("a raise over a real limit still reads over cap", () => {
    for (const r of ["over_absolute_ceiling", "over_pct_change", "over_daily_aggregate"]) {
      expect(capFieldValue({ ...raise, cap_reason: r })).toBe("Over your configured cap");
    }
  });

  it("an older body without cap_reason: a neutral line for a raise, none for a cut or a status change", () => {
    expect(capFieldValue(raise)).toBe("Outside the automatic spend rules, so this waits for your approval");
    expect(capFieldValue(cut)).toBeNull();
    expect(capFieldValue({ over_cap: true, status: "PAUSED" })).toBeNull();
  });

  it("an unknown cap_reason shows nothing", () => {
    expect(capFieldValue({ ...raise, cap_reason: "something_new" })).toBeNull();
  });

  it("a founder-staged edit or a within-cap body has no cap line", () => {
    expect(capFieldValue({ ...raise, origin: "user_initiated_ledger" })).toBeNull();
    expect(capFieldValue({ ...raise, over_cap: false })).toBeNull();
  });

  it("the rendered card carries the truthful line", () => {
    const s = JSON.stringify(
      buildApprovalBlocks({
        id: "d9",
        decision_class: "meta_ads.update_ad_set_budget_review",
        body: { name: "Search ad set", rationale: "Shift budget.", ...cut, cap_reason: "no_cap_configured" },
      }),
    );
    expect(s).toContain("No spend limit is set");
    expect(s).not.toContain("Over your configured cap");
  });
});

describe("buildApprovalBlocks — a raise approved in Zavi only", () => {
  const raiseCard = {
    id: "d10",
    decision_class: "meta_ads.update_ad_set_budget_review",
    body: { name: "Sales Search", daily_budget_usd: 150, expected_current_daily_budget_usd: 120 },
  };
  const NOTE = "October is projected at about $27,040, over your $27,000 budget. Choose in Zavi.";

  it("must-catch: the note is shown as context with an Open in Zavi link, and there is no Approve or Edit budget button", () => {
    const blocks = buildApprovalBlocks({ ...raiseCard, web_only_note: NOTE }) as Array<{ type: string; elements?: Array<Record<string, unknown>> }>;
    const context = blocks.filter((b) => b.type === "context").flatMap((b) => b.elements ?? []);
    expect(context.some((e) => e.text === NOTE)).toBe(true);
    const buttons = blocks.filter((b) => b.type === "actions").flatMap((b) => b.elements ?? []);
    const open = buttons.find((e) => (e.text as { text?: string }).text === "Open in Zavi");
    expect(open?.url).toEqual(expect.any(String));
    expect(buttons.map((e) => e.action_id)).not.toContain("praxis_approve");
    expect(buttons.map((e) => e.action_id)).not.toContain("praxis_edit");
    expect(buttons.map((e) => e.action_id)).toContain("praxis_reject");
  });

  it("must-not-touch: without a note the raise keeps its Approve button", () => {
    const buttons = (buildApprovalBlocks(raiseCard) as Array<{ type: string; elements?: Array<Record<string, unknown>> }>).filter((b) => b.type === "actions").flatMap((b) => b.elements ?? []);
    expect(buttons.map((e) => e.action_id)).toContain("praxis_approve");
  });
});
