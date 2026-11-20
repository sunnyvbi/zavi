import { describe, expect, it } from "vitest";
import {
  bulkDraftLine,
  agentLabelForSlug,
  decisionTitle,
  dispatchCardHeadline,
  expectedScheduledAtFor,
  formatScheduledAt,
  handlerPreview,
  loadedScheduleGuard,
  scheduleMovedNotice,
} from "./approvalsHelpers";

describe("plain Approve after a calendar move", () => {
  it("a social post's plain Approve forwards the time the card loaded, null included", () => {
    expect(
      loadedScheduleGuard({ decision_class: "social.publish.v2", body: { scheduled_at: "2026-10-05T16:00:00Z" } }),
    ).toEqual({ expectedScheduledAt: "2026-10-05T16:00:00Z" });
    expect(loadedScheduleGuard({ decision_class: "social.publish.v2", body: {} })).toEqual({ expectedScheduledAt: null });
  });
  it("every other class sends nothing", () => {
    expect(loadedScheduleGuard({ decision_class: "meta_ads.set_status", body: { scheduled_at: "x" } })).toEqual({});
  });
});

describe("approve-at-this-time after a calendar move", () => {
  it("approving the loaded time carries it as expected_scheduled_at", () => {
    expect(expectedScheduledAtFor(false, "2026-10-05T16:00:00Z")).toBe("2026-10-05T16:00:00Z");
    expect(expectedScheduledAtFor(false, null)).toBeNull();
  });
  it("a time re-picked in the panel is the founder's intent: no stale check", () => {
    expect(expectedScheduledAtFor(true, "2026-10-05T16:00:00Z")).toBeUndefined();
  });
  it("the moved notice names the new time, or publish-on-approval when cleared", () => {
    expect(scheduleMovedNotice("2026-10-05T16:00:00Z")).toMatch(/^This was moved to .+\. Approve again\?$/);
    expect(scheduleMovedNotice(null)).toBe("This was changed to publish when approved. Approve again?");
  });
});

describe("decisionTitle — growth suggestions", () => {
  it("labels the client approval as a growth recommendation", () => {
    expect(decisionTitle("growth-lead.suggestion")).toEqual({
      agentLabel: "Head of Growth",
      verbLabel: "Growth recommendation",
    });
  });
});

describe("handlerPreview — description for common agent handlers", () => {
  it("praxis.dispatch_specialist leads with target agent + intent", () => {
    expect(
      handlerPreview("praxis.dispatch_specialist", {
        intent: "Rotate the exposed deploy key immediately.",
        target_agent_slug: "engineer",
      }),
    ).toBe("→ engineer · Rotate the exposed deploy key immediately.");
  });

  it("pm.needs_action shows theme + why (exception_kind)", () => {
    expect(
      handlerPreview("pm.needs_action", {
        theme: "DL barcode parsing missing from DriverVerification.tsx",
        exception_kind: "stuck",
        proposed_action: "redispatch_and_close_pr",
      }),
    ).toBe(
      "→ DL barcode parsing missing from DriverVerification.tsx · fix stuck",
    );
  });

  it("digest.post surfaces the top priority item + count", () => {
    expect(
      handlerPreview("digest.post", {
        tier1: [{ title: "PEM deploy key exposed" }, { title: "b" }],
        tier2: [],
        tier3: [],
      }),
    ).toBe("→ Digest · PEM deploy key exposed +1 more");
  });

  it("autopilot.daily_plan_approve shows the objective", () => {
    expect(
      handlerPreview("autopilot.daily_plan_approve", {
        objective: "Daily plan — drive: Grow weekly guest signups",
      }),
    ).toBe("→ Daily plan — drive: Grow weekly guest signups");
  });

  it("memory.write_meeting_atoms shows note count + meeting title", () => {
    expect(
      handlerPreview("memory.write_meeting_atoms", {
        atoms: [{}, {}, {}],
        title: "Weekly standup",
      }),
    ).toBe('→ Save 3 notes from "Weekly standup"');
  });

  it("social.publish.v2 shows channel + post text", () => {
    expect(
      handlerPreview("social.publish.v2", {
        channel: "linkedin",
        payload: { text: "The math renters are running right now" },
      }),
    ).toBe('→ Linkedin · "The math renters are running right now"');
  });

  it("social.publish.v2 on Pinterest names the pin by its title, never the raw channel key", () => {
    expect(
      handlerPreview("social.publish.v2", {
        channel: "pinterest_pin",
        payload: { title: "Cake", text: "ihio" },
      }),
    ).toBe('→ Pinterest pin · "Cake"');
    expect(handlerPreview("social.publish.v2", { channel: "pinterest_pin", payload: { text: "only words" } })).toBe('→ Pinterest pin · "only words"');
    expect(handlerPreview("social.publish.v2", { channel: "pinterest_pin", payload: {} })).toBe("→ Pinterest pin · post pin");
  });

  it("social.publish.v2 appends the scheduled time when the body carries one", () => {
    const iso = "2099-01-02T09:00:00.000Z";
    const line = handlerPreview("social.publish.v2", {
      channel: "linkedin",
      payload: { text: "Later" },
      scheduled_at: iso,
    });
    expect(line).toBe(`→ Linkedin · "Later" · ${formatScheduledAt(iso)}`);
    expect(formatScheduledAt("soon")).toBeNull();
    expect(formatScheduledAt(null)).toBeNull();
    expect(
      handlerPreview("social.publish.v2", { channel: "linkedin", payload: { text: "Now" }, scheduled_at: null }),
    ).toBe('→ Linkedin · "Now"');
  });

  it("degrades gracefully when body fields are missing (never throws / never slug)", () => {
    expect(handlerPreview("praxis.dispatch_specialist", {})).toBe(
      "→ specialist · start on this work",
    );
    expect(handlerPreview("digest.post", {})).toBe("→ Daily digest");
    expect(handlerPreview("pm.needs_action", {})).toBe("→ a roadmap item");
  });

  it("unknown handler still returns null (caller hides the line)", () => {
    expect(handlerPreview("totally.unknown", { x: 1 })).toBeNull();
    expect(handlerPreview(null, {})).toBeNull();
  });
});

describe("dispatchCardHeadline — the ask leads, routing is the byline", () => {
  it("leads with the intent's first sentence and names the target", () => {
    expect(
      dispatchCardHeadline({
        intent:
          "Card-testing attack on cus_Ut4Q5syowTocQs: 8 failed charges + 1 succeeded-then-refunded ($319.20) in ~90 min today. Identify and block the source.",
        target_agent_slug: "support-lead",
      }),
    ).toEqual({
      headline:
        "Card-testing attack on cus_Ut4Q5syowTocQs: 8 failed charges + 1 succeeded-then-refunded ($319.20) in ~90 min…",
      targetLabel: "Support Lead",
    });
  });

  it("takes the first LINE of a multi-line growth-lead intent", () => {
    expect(
      dispatchCardHeadline({
        intent:
          "Requested action: weekly-plan\nGrowth bet: seed 20 creators\nRationale: cheap reach",
        target_agent_slug: "growth-lead",
      })?.headline,
    ).toBe("Requested action: weekly-plan");
  });

  it("keeps the whole line when the first sentence is too short to carry signal", () => {
    expect(
      dispatchCardHeadline({
        intent: "Fix P0. Any authenticated user can read others' payment methods.",
        target_agent_slug: "engineer",
      })?.headline,
    ).toBe("Fix P0. Any authenticated user can read others' payment methods.");
  });

  it("truncates a long single sentence rather than overflowing the card", () => {
    const long = `Investigate ${"x".repeat(200)}`;
    const out = dispatchCardHeadline({ intent: long, target_agent_slug: "qa" });
    expect(out?.headline.length).toBeLessThanOrEqual(111);
    expect(out?.headline.endsWith("…")).toBe(true);

    const spaced = `Investigate ${"word ".repeat(60)}`;
    const out2 = dispatchCardHeadline({ intent: spaced, target_agent_slug: "qa" });
    expect(out2?.headline.endsWith("word…")).toBe(true);
  });

  it("degrades to null with no usable intent, and never renders an object", () => {
    expect(dispatchCardHeadline({ target_agent_slug: "engineer" })).toBeNull();
    expect(dispatchCardHeadline({ intent: "   " })).toBeNull();
    expect(
      dispatchCardHeadline({ intent: "Do the thing.", target_agent_slug: { a: 1 } })
        ?.targetLabel,
    ).toBe("the specialist");
  });
});

describe("agentLabelForSlug", () => {
  it("maps known slugs to the same labels decisionTitle uses", () => {
    expect(agentLabelForSlug("support-lead")).toBe("Support Lead");
    expect(agentLabelForSlug("engineer")).toBe("CTO engineer");
  });
  it("falls back readably for unknown/blank slugs", () => {
    expect(agentLabelForSlug("brand-new-agent")).toBe("Brand New Agent");
    expect(agentLabelForSlug("content-design")).toBe("Content Designer");
    expect(agentLabelForSlug("")).toBe("the specialist");
    expect(agentLabelForSlug(undefined)).toBe("the specialist");
  });
});

import { refineTarget } from "./approvalsHelpers";

describe("refineTarget", () => {
  it("routes a channel executor to the operator thread with an @-mention prefix", () => {
    expect(refineTarget("x_organic")).toEqual({ agent: "operator", seedPrefix: "@X " });
    expect(refineTarget("meta_ads").agent).toBe("operator");
    expect(refineTarget("geo")).toEqual({ agent: "operator", seedPrefix: "@GEO " });
  });
  it("leaves a normal agent alone", () => {
    expect(refineTarget("engineer")).toEqual({ agent: "engineer", seedPrefix: "" });
    expect(refineTarget("operator")).toEqual({ agent: "operator", seedPrefix: "" });
  });
});

describe("Composio writes need the full card (spec 12)", () => {
  it("needsFullCard is true only for the composio.execute_tool handler", async () => {
    const { needsFullCard } = await import("./approvalsHelpers");
    expect(needsFullCard("composio.execute_tool")).toBe(true);
    expect(needsFullCard("jira.create_issue")).toBe(false);
    expect(needsFullCard(null)).toBe(false);
  });
  it("isHighStakesDecision is true for any Composio write, so every shortcut offers Review", async () => {
    const { isHighStakesDecision } = await import("./approvalsHelpers");
    expect(isHighStakesDecision("composio.write", "composio.execute_tool", {})).toBe(true);
    expect(isHighStakesDecision("composio.write", null, {})).toBe(true);
  });
  it("isHighStakesDecision is true for every ad platform whose exec classes move spend", async () => {
    const { isHighStakesDecision } = await import("./approvalsHelpers");
    for (const cls of [
      "meta_ads.set_status",
      "google_ads.update_campaign_budget",
      "linkedin_ads.set_status",
      "linkedin_ads.create_campaign_bundle",
      "reddit_ads.set_status",
      "chatgpt_ads.create_campaign_bundle",
    ]) {
      expect(isHighStakesDecision(cls, null, {}), cls).toBe(true);
    }
    expect(isHighStakesDecision("linkedin_organic.post", null, {})).toBe(false);
  });
  it("approveExtrasFor echoes the card's fingerprint for a Composio write, nothing otherwise", async () => {
    const { approveExtrasFor } = await import("./approvalsHelpers");
    const fp = "c".repeat(64);
    expect(approveExtrasFor({ handler: "composio.execute_tool", body: { fingerprint: fp } })).toEqual({ expected_fingerprint: fp });
    expect(approveExtrasFor({ handler: "composio.execute_tool", body: {} })).toEqual({});
    expect(approveExtrasFor({ handler: "jira.create_issue", body: { fingerprint: fp } })).toEqual({});
  });
  it("outcomeUnknownRows keeps only composio rows stuck 'dispatching' for over 10 minutes", async () => {
    const { outcomeUnknownRows } = await import("./approvalsHelpers");
    const now = Date.parse("2026-09-25T12:00:00Z");
    const rows = [
      { id: "old", handler: "composio.execute_tool", status: "dispatching", dispatched_at: "2026-09-25T11:40:00Z" },
      { id: "fresh", handler: "composio.execute_tool", status: "dispatching", dispatched_at: "2026-09-25T11:55:00Z" },
      { id: "other", handler: "jira.create_issue", status: "dispatching", dispatched_at: "2026-09-25T10:00:00Z" },
      { id: "nodate", handler: "composio.execute_tool", status: "dispatching", dispatched_at: null },
      { id: "done", handler: "composio.execute_tool", status: "acted", dispatched_at: "2026-09-25T10:00:00Z" },
    ];
    expect(outcomeUnknownRows(rows, now).map((r) => r.id)).toEqual(["old"]);
  });
});

describe("Zavi-money cards are approved from the full card only", () => {
  it("a charge or payout echoes the card's seal; other cards send nothing extra", async () => {
    const { approveExtrasFor, needsFullCard } = await import("./approvalsHelpers");
    expect(needsFullCard("stripe.create_payment")).toBe(true);
    expect(needsFullCard("stripe.remit_to_tenant")).toBe(true);
    expect(needsFullCard("jira.create_issue")).toBe(false);
    expect(approveExtrasFor({ handler: "stripe.remit_to_tenant", body: { fingerprint: "abc" } })).toEqual({ expected_fingerprint: "abc" });
    expect(approveExtrasFor({ handler: "jira.create_issue", body: { fingerprint: "abc" } })).toEqual({});
  });
});

describe("bulk email draft line", () => {
  it("names the draft by its subject and never shows the class name", () => {
    expect(bulkDraftLine({ template: { subject: "Come back for 10% off" } })).toBe(
      "Draft “Come back for 10% off”, not sent",
    );
    expect(bulkDraftLine({})).toBe("Bulk email draft, not sent");
    expect(bulkDraftLine(null)).not.toContain("bulk_outbound");
  });
});

describe("bulk email to a contact list", () => {
  const body = {
    list_version_id: "22222222-2222-4222-8222-222222222222",
    list_name: "Newsletter",
    template: { subject: "Come back for 10% off" },
    est_recipient_count: 1200,
  };
  it("the queue line says it is waiting for approval, never that it was not sent", () => {
    expect(bulkDraftLine(body)).toBe("Email “Come back for 10% off” to Newsletter (1,200), waiting for your approval");
    expect(bulkDraftLine(body)).not.toMatch(/not sent/);
  });
});
