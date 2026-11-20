import { describe, it, expect } from "vitest";
import { buildApprovalBlocks } from "../slack-approval-blocks";

function flatText(blocks: unknown[]): string {
  return JSON.stringify(blocks);
}

describe("buildApprovalBlocks — rendered_markdown + array-of-objects", () => {
  it("chief-of-staff.daily-digest: renders body.rendered_markdown, NOT the contentless fallback", () => {
    const blocks = buildApprovalBlocks({
      id: "d1",
      decision_class: "chief-of-staff.daily-digest",
      body: {
        tier1: [{ title: "PEM deploy key exposed", summary: "rotate it" }],
        tier2: [{ area: "ads", summary: "2.61x ROAS" }],
        rendered_markdown:
          "# Daily digest — Thu Jul 2\n\n## Tier 1 — Decide today\n\n**PEM deploy key exposed** — rotate and purge it.\n\n---\n\n## Tier 2 — Growth pulse\n\nBlended 2.61x ROAS, $3,202 spend.",
      },
    });
    const s = flatText(blocks);
    expect(s).not.toContain("No structured evidence");
    expect(s).toContain("Daily digest");
    expect(s).toContain("PEM deploy key exposed");
    expect(s).toContain("2.61x ROAS");
    expect(s).not.toContain("# Daily digest");
    expect(s).not.toContain("**PEM");
    expect(s).toContain("praxis_approve");
    expect(s).toContain("praxis_reject");
  });

  it("notetaker.write_atoms: lists the fact titles being written, not just the meeting date", () => {
    const blocks = buildApprovalBlocks({
      id: "n1",
      decision_class: "notetaker.write_atoms",
      body: {
        title: "Standup 2026-07-01: 3 durable fact(s) for the company brain",
        meeting_date: "2026-07-01",
        meeting_bot_id: "32f69450-5ea7-4c34-a8cd-637fc6ebd036",
        atoms: [
          { title: "Release cadence: frequent small cuts required", atom_type: "policy" },
          { title: "Engineers must work multiple tasks in parallel", atom_type: "policy" },
          { title: "Android app is published to Play Store", atom_type: "spec_fact" },
        ],
      },
    });
    const s = flatText(blocks);
    expect(s).not.toContain("No structured evidence");
    expect(s).toContain("Standup 2026-07-01");
    expect(s).toContain("Release cadence: frequent small cuts required");
    expect(s).toContain("Engineers must work multiple tasks in parallel");
    expect(s).toContain("Android app is published to Play Store");
    expect(s).not.toContain("32f69450");
  });

  it("notetaker.write_atoms: renders each atom's FULL body + provenance, not just the title", () => {
    const blocks = buildApprovalBlocks({
      id: "n2",
      decision_class: "notetaker.write_atoms",
      body: {
        title: "Standup 2026-07-06: 2 durable fact(s) for the company brain",
        meeting_date: "2026-07-06",
        atoms: [
          {
            atom_type: "policy",
            title: "Tracking plan is canonical source of truth for event implementation",
            body: "All event instrumentation must be defined in the tracking plan first; code follows the plan, never the reverse.",
            owner: "Ravi",
            confidence: "high",
            source_excerpt: "the tracking plan is the source of truth, engineers implement off it",
          },
          {
            atom_type: "decision",
            title: "Release cadence: staggered platforms",
            body: "No same-day all-platform releases; ship one platform at a time to contain blast radius.",
            confidence: "medium",
            source_excerpt: "we should never release all platforms the same day",
          },
        ],
      },
    });
    const s = flatText(blocks);
    expect(s).not.toContain("No structured evidence");
    expect(s).toContain("Tracking plan is canonical source of truth");
    expect(s).toContain("All event instrumentation must be defined in the tracking plan first");
    expect(s).toContain("No same-day all-platform releases");
    expect(s).toContain("from transcript");
    expect(s).toContain("the tracking plan is the source of truth");
    expect(s).toContain("owner: Ravi");
    expect(s).toContain("high confidence");
    expect(s).toContain("Approve saves all 2 facts below to your company brain");
    expect(s).toContain("praxis_approve");
    expect(s).toContain("praxis_reject");
  });

  it("notetaker.write_atoms: shown == saved — EVERY atom rendered, none capped (approve saves them all)", () => {
    const atoms = Array.from({ length: 18 }, (_, i) => ({
      atom_type: "spec_fact",
      title: `Fact number ${i + 1}`,
      body: `Body of fact ${i + 1}`,
    }));
    const blocks = buildApprovalBlocks({
      id: "n3",
      decision_class: "notetaker.write_atoms",
      body: { title: "Standup", meeting_date: "2026-07-06", atoms },
    });
    const s = flatText(blocks);
    for (let i = 1; i <= 18; i++) expect(s).toContain(`Fact number ${i}`);
    expect(s).not.toContain("more — open");
    expect((blocks as unknown[]).length).toBeLessThan(50);
  });

  it("notetaker.write_atoms: a long fact body is chunked, never truncated (shown == saved)", () => {
    const longBody = "X".repeat(1900);
    const blocks = buildApprovalBlocks({
      id: "n4",
      decision_class: "notetaker.write_atoms",
      body: {
        title: "Standup",
        meeting_date: "2026-07-06",
        atoms: [{ atom_type: "policy", title: "Long fact", body: longBody }],
      },
    });
    const s = flatText(blocks);
    expect(s).toContain(longBody);
    expect(s).not.toContain("X…");
  });

  it("autopilot.daily-plan: keeps the objective headline and lists the plan step", () => {
    const blocks = buildApprovalBlocks({
      id: "a1",
      decision_class: "autopilot.daily-plan",
      body: {
        cron_date: "2026-07-02",
        objective: "Daily plan 2026-07-02 — drive: Grow Upcar weekly guest signups",
        conductor_run_id: "c9407b87-dd26-4d16-b523-676bd086c8c6",
        plan_graph: [{ target_agent_slug: "chief-of-staff", status: "pending", estimate_usd: 0.5 }],
      },
    });
    const s = flatText(blocks);
    expect(s).not.toContain("No structured evidence");
    expect(s).toContain("drive: Grow Upcar weekly guest signups");
    expect(s).toContain("chief-of-staff");
    expect(s).not.toContain("c9407b87");
  });

  it("rendered_markdown wins over the generic summarizer when both could apply", () => {
    const blocks = buildApprovalBlocks({
      id: "d2",
      decision_class: "chief-of-staff.daily-digest",
      body: {
        objective: "should-not-lead-when-md-present",
        rendered_markdown: "## The real render\n\nActionable detail here.",
      },
    });
    const s = flatText(blocks);
    expect(s).toContain("The real render");
    expect(s).toContain("Actionable detail here");
  });

  it("md→Slack conversion is line-safe: a blank line after a header is preserved, a bare '#' does not swallow the next line", () => {
    const blocks = buildApprovalBlocks({
      id: "d4",
      decision_class: "chief-of-staff.daily-digest",
      body: { rendered_markdown: "# Header line\n\nBody paragraph\n\n#\nStandalone detail" },
    });
    const md: string = (blocks as Array<{ type: string; text?: { text: string } }>)
      .filter((b) => b.type === "section" && b.text)
      .map((b) => b.text!.text)
      .join("\n");
    expect(md).toContain("*Header line*");
    expect(md).toMatch(/\*Header line\*\n\nBody paragraph/);
    expect(md).toContain("Standalone detail");
    expect(md).not.toContain("*Standalone detail*");
  });

  it("meta_ads money card wins over rendered_markdown (never regress the $X→$Y budget display)", () => {
    const blocks = buildApprovalBlocks({
      id: "m1",
      decision_class: "meta_ads.update_ad_set_budget",
      body: {
        name: "Prospecting",
        daily_budget_usd: 100,
        expected_current_daily_budget_usd: 50,
        rendered_markdown: "Budget change queued.",
      },
    });
    const s = flatText(blocks);
    expect(s).toContain("$50/day → $100/day");
    expect(s).not.toContain("Budget change queued.");
  });

  it("decision_evidence envelope still wins over rendered_markdown", () => {
    const blocks = buildApprovalBlocks({
      id: "d3",
      decision_class: "chief-of-staff.daily-digest",
      body: {
        rendered_markdown: "## Should not lead",
        decision_evidence: {
          reason_text: "Envelope reason wins",
          evidence: ["e"],
          alternatives_considered: [],
          reversibility: "reversible",
          blast_radius: "GREEN",
          confidence: 0.9,
        },
      },
    });
    const s = flatText(blocks);
    expect(s).toContain("Envelope reason wins");
    expect(s).not.toContain("Should not lead");
  });
});
