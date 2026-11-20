import { describe, it, expect } from "vitest";
import {
  decisionCardTitle,
  decisionConsequence,
  statusChip,
  STATUS_CHIP_KEYS,
} from "@/services/approvals/decision-copy";

describe("decisionCardTitle", () => {
  it("names the admin-curated growth suggestion plainly", () => {
    expect(decisionCardTitle("growth-lead.suggestion")).toBe("Review a growth recommendation");
  });
  it("uses an explicit override when present", () => {
    expect(decisionCardTitle("engineer.ship-pr")).toBe("Ship code — open a pull request");
    expect(decisionCardTitle("send_email")).toBe("Send an email");
  });

  it("falls back to `{Agent} — {verb}` for unmapped agent.verb classes", () => {
    expect(decisionCardTitle("operator.some-new-thing")).toBe("Operator — some new thing");
  });

  it("handles a bare (dotless) class without throwing", () => {
    expect(decisionCardTitle("proposed_global_rule")).toBe("Add a standing rule for your fleet");
    expect(decisionCardTitle("totally_unknown_class")).toBe("Totally unknown class");
  });

  it("never returns the raw machine slug for a known agent", () => {
    const t = decisionCardTitle("growth-lead.brand-new-verb");
    expect(t).toBe("Growth lead — brand new verb");
    expect(t).not.toContain(".");
  });
});

describe("decisionConsequence", () => {
  it("states that accepting a growth suggestion records it without mutating Meta", () => {
    const c = decisionConsequence(null, "growth-lead.suggestion", {});
    expect(c.approve).toMatch(/records this growth recommendation/i);
    expect(c.approve).toMatch(/does not change Meta Ads automatically/i);
    expect(c.reject).toMatch(/archives/i);
  });
  it("gives PR-specific copy that makes clear approve does NOT deploy", () => {
    const c = decisionConsequence("github.open_pr");
    expect(c.approve).toMatch(/pull request/i);
    expect(c.approve).toMatch(/nothing merges or deploys/i);
    expect(c.reject).toMatch(/no pull request/i);
  });

  it("matches ad-platform handlers by prefix", () => {
    expect(decisionConsequence("meta_ads.update_ad_set_budget").approve).toContain("Meta Ads");
    expect(decisionConsequence("google_ads.set_status_review").approve).toContain("Google Ads");
  });

  it("falls back to generic copy for a null / unknown handler", () => {
    const g = decisionConsequence(null);
    expect(g.approve).toMatch(/lets the agent proceed/i);
    expect(decisionConsequence("some.unmapped_handler").reject).toMatch(/won't proceed/i);
  });

  it("names the real effect of a set_status write from the body", () => {
    const paused = decisionConsequence("meta_ads.set_status_review", "meta_ads.set_status_review", {
      status: "PAUSED",
      level: "adset",
      name: "Bay Area Rentals 2026-04-29",
    });
    expect(paused.approve).toMatch(/pauses/i);
    expect(paused.approve).toContain("Bay Area Rentals 2026-04-29");
    expect(paused.approve).toMatch(/stops spending/i);
    expect(paused.reject).toMatch(/keeps running/i);

    const active = decisionConsequence("meta_ads.set_status", "meta_ads.set_status", {
      status: "ACTIVE",
      level: "campaign",
      name: "Winter Push",
    });
    expect(active.approve).toMatch(/turns .*back on/i);
    expect(active.approve).toMatch(/starts delivering/i);
    expect(active.reject).toMatch(/stays paused/i);
  });

  it("names the from → to amounts of a budget write", () => {
    const c = decisionConsequence("meta_ads.update_ad_set_budget", undefined, {
      name: "Bay Area Rentals",
      daily_budget_usd: 80,
      expected_current_daily_budget_usd: 50,
    });
    expect(c.approve).toContain("$50");
    expect(c.approve).toContain("$80");
    expect(c.reject).toContain("$50");
  });

  it("degrades to the vague-but-true line rather than inventing a specific", () => {
    expect(decisionConsequence("meta_ads.set_status").approve).toBe("Applies the change in Meta Ads.");
    const junk = decisionConsequence("meta_ads.set_status", undefined, { status: 42 });
    expect(junk.approve).toBe("Applies the change in Meta Ads.");
    expect(junk.approve).not.toMatch(/pauses|turns/i);
  });

  it("says a new ad set lands PAUSED so approve reads as no immediate spend", () => {
    const c = decisionConsequence("meta_ads.create_ad_set", undefined, {
      name: "Test Set",
      daily_budget_usd: 25,
    });
    expect(c.approve).toMatch(/PAUSED/);
    expect(c.approve).toContain("$25");
  });
});

describe("statusChip", () => {
  it("maps engineer booleans to good/warn tones", () => {
    expect(statusChip("typecheck_ok", true)).toEqual({ label: "Code compiles", tone: "good" });
    expect(statusChip("typecheck_ok", false)?.tone).toBe("warn");
    expect(statusChip("http_route_changed", true)?.tone).toBe("warn");
    expect(statusChip("http_route_changed", false)).toBeNull();
  });

  it("shows no chip for the removed CTO critic's legacy ship-gate values", () => {
    expect(statusChip("ship_gate_warning", "critic_fail")).toBeNull();
    expect(statusChip("ship_gate_warning", "task_mismatch")).toBeNull();
    expect(statusChip("ship_gate_warning", "none")).toBeNull();
    expect(statusChip("ship_gate_warning", "tests_failed")).toEqual({ label: "Some tests failed", tone: "warn" });
  });

  it("keeps every chip key resolvable", () => {
    for (const k of STATUS_CHIP_KEYS) {
      expect(() => statusChip(k, "low")).not.toThrow();
    }
  });
});

describe("decisionConsequence — praxis.dispatch_specialist names the target", () => {
  it("names the target agent on approve and reject", () => {
    const c = decisionConsequence(
      "praxis.dispatch_specialist",
      "chief-of-staff.dispatch-specialist",
      { target_agent_slug: "support-lead", intent: "Block the card-testing source." },
    );
    expect(c.approve).toContain("Starts Support Lead on this work now");
    expect(c.reject).toBe("Support Lead is not started. Nothing else changes.");
  });

  it("degrades to the generic wording when the body carries no usable target", () => {
    for (const body of [{}, { target_agent_slug: "" }, { target_agent_slug: { a: 1 } }]) {
      const c = decisionConsequence("praxis.dispatch_specialist", null, body);
      expect(c.approve).toBe("Hands the work to the specialist agent to start on.");
      expect(c.reject).toBe("The specialist agent is not dispatched.");
    }
    expect(decisionConsequence("praxis.dispatch_specialist").approve).toBe(
      "Hands the work to the specialist agent to start on.",
    );
  });

  it("refuses to name a malformed slug (Slack mrkdwn injection guard)", () => {
    for (const bad of [
      "<!channel>",
      "engineer\n<!here> urgent",
      "Engineer",
      "*bold*",
      "a".repeat(60),
    ]) {
      const c = decisionConsequence("praxis.dispatch_specialist", null, {
        target_agent_slug: bad,
      });
      expect(c.approve).toBe("Hands the work to the specialist agent to start on.");
    }
  });

  it("leaves other handlers untouched", () => {
    expect(decisionConsequence("slack.post_message").approve).toBe(
      "Posts the message to Slack.",
    );
  });
});

describe("decisionConsequence — social.publish.v2 reads scheduled_at", () => {
  it("says 'now' when the body carries no time", () => {
    for (const body of [{}, { scheduled_at: null }, { scheduled_at: "not a date" }]) {
      const c = decisionConsequence("social.publish.v2", "social.publish.v2", body);
      expect(c.approve).toMatch(/Publishes the post now/);
      expect(c.reject).toMatch(/Nothing is published/);
    }
  });

  it("names the time in UTC when the body carries one", () => {
    const c = decisionConsequence("social.publish.v2", "social.publish.v2", {
      scheduled_at: "2099-01-02T09:00:00.000Z",
    });
    expect(c.approve).toBe("Publishes the post on Fri, Jan 2, 9:00 AM UTC to the connected social account.");
  });
});

describe("decisionConsequence — x_ads.* uses the card's spend summary", () => {
  it("a live create says it spends, a reject creates nothing", () => {
    const c = decisionConsequence("x_ads.create_campaign", "x_ads.create_campaign", {
      summary: 'Zavi starts "Launch" in X Ads, promoting 2 posts. It spends up to $25.00 a day from the moment it is created.',
    });
    expect(c.approve).toMatch(/spends up to \$25\.00 a day/);
    expect(c.reject).toBe("No campaign is created.");
  });

  it("a pause keeps spending on reject", () => {
    const c = decisionConsequence("x_ads.set_status", "x_ads.set_status", { status: "PAUSED", summary: 'Zavi pauses "Spring" in X Ads.' });
    expect(c.reject).toMatch(/keeps spending/);
  });

  it("a campaign name cannot ping or reshape the Slack card", () => {
    const c = decisionConsequence("x_ads.set_status", "x_ads.set_status", { status: "PAUSED", summary: 'Zavi pauses "<!channel>\n*Reject* → x" in X Ads.' });
    expect(c.approve).toBe('Zavi pauses "&lt;!channel&gt; *Reject* → x" in X Ads.');
  });
});

describe("bulk_outbound.send copy (Slack card + admin needs-help)", () => {
  it("an older draft (no contact list) is titled a draft and never promises a send", () => {
    expect(decisionCardTitle("bulk_outbound.send", { selector: { segment: "lapsed" } })).toBe("Bulk email draft (not sent)");
    const c = decisionConsequence("bulk_outbound.send", "bulk_outbound.send", {});
    expect(c.approve).toMatch(/^Sends nothing\./);
    expect(c.approve).not.toMatch(/everyone in the list/i);
  });

  it("a bulk email to a contact list says who it is sent to, from which address", () => {
    const body = {
      list_id: "11111111-1111-4111-8111-111111111111",
      list_version_id: "22222222-2222-4222-8222-222222222222",
      list_name: "Newsletter",
      from_address: "hello@acme.com",
      template: { subject: "Hi", body_text: "Come back." },
      est_recipient_count: 1200,
    };
    expect(decisionCardTitle("bulk_outbound.send", body)).toBe("Send a bulk email");
    expect(decisionConsequence("bulk_outbound.send", "bulk_outbound.send", body)).toEqual({
      approve:
        "Sends this email to 1,200 people on the list shown below, from the address shown below. One email per person. Each email includes an unsubscribe link and your address.",
      reject: "Nothing is sent — the draft is kept.",
    });
  });

  it("with no body the title claims neither a send nor a draft", () => {
    expect(decisionCardTitle("bulk_outbound.send")).toBe("Bulk email");
  });

  it("keeps the single-recipient send distinct", () => {
    expect(decisionCardTitle("outbound.send")).toBe("Send an outbound message");
    expect(decisionConsequence("outbound.send", "outbound.send", {}).approve).toBe("Sends the message.");
  });
});

describe("bulk_outbound.send copy is keyed on the class", () => {
  it("says nothing is sent even with no or a wrong handler", () => {
    expect(decisionConsequence(null, "bulk_outbound.send", {}).approve).toMatch(/^Sends nothing\./);
    expect(decisionConsequence("outbound.send", "bulk_outbound.send", {}).approve).toMatch(/^Sends nothing\./);
  });
});

describe("linkedin_ads.launch_campaign copy", () => {
  const body = {
    campaign_binding_id: "8f1c2d7e-1111-4222-8333-444455556666",
    name: "Founders webinar",
    total_budget_usd: 500,
    end_time: Date.UTC(2026, 10, 12, 12),
  };
  const approveFor = (total: string) =>
    `Launches “Founders webinar” in LinkedIn Ads with a ${total} total budget and an end date of Nov 12, 2026, 12:00 PM UTC. It starts spending as soon as LinkedIn approves the ad.`;

  it.each([
    ["handler", "linkedin_ads.launch_campaign", null],
    ["class only", null, "linkedin_ads.launch_campaign"],
  ])("names the campaign, total budget and end date (%s)", (_l, handler, cls) => {
    const c = decisionConsequence(handler, cls, body);
    expect(c.approve).toBe(approveFor("$500"));
    expect(c.reject).toBe("“Founders webinar” is not launched and the campaign stays paused. Nothing is spent.");
    expect(c.approve).not.toMatch(/8f1c2d7e|campaign_binding|Applies the change/);
  });

  it.each([
    [1234.5, "$1,234.50"],
    [5000, "$5,000"],
    [99.99, "$99.99"],
  ])("shows a total budget of %s as %s", (total, shown) => {
    const c = decisionConsequence("linkedin_ads.launch_campaign", null, { ...body, total_budget_usd: total });
    expect(c.approve).toBe(approveFor(shown));
  });

  it("Flow 46: Slack has no viewer timezone, so the end shows its time and says UTC, the same moment the chat card names", () => {
    const c = decisionConsequence("linkedin_ads.launch_campaign", null, { ...body, end_time: Date.UTC(2026, 10, 13, 2, 30) });
    expect(c.approve).toContain("an end date of Nov 13, 2026, 2:30 AM UTC.");
  });

  it.each([
    ["missing", {}],
    ["empty", { name: "" }],
    ["whitespace only", { name: "   " }],
  ])("falls back to specific-but-safe wording when the name is %s", (_l, body) => {
    const c = decisionConsequence("linkedin_ads.launch_campaign", "linkedin_ads.launch_campaign", body);
    expect(c.approve).toBe("Launches the campaign in LinkedIn Ads. It starts spending as soon as LinkedIn approves the ad.");
    expect(c.reject).toBe("The campaign is not launched and stays paused. Nothing is spent.");
  });

  it("shows a non-USD account's total in its own currency first, with the dollar figure beside it", () => {
    const c = decisionConsequence("linkedin_ads.launch_campaign", null, { ...body, currency: "INR", total_budget_cents: 1_660_000, total_budget_usd: 200 });
    expect(c.approve).toBe(approveFor("₹16,600 (about $200)"));
  });

  it("shows a USD account's total once", () => {
    const c = decisionConsequence("linkedin_ads.launch_campaign", null, { ...body, currency: "USD", total_budget_cents: 50_000, total_budget_usd: 500 });
    expect(c.approve).toBe(approveFor("$500"));
  });

  it("drops a missing or invalid end time and budget without printing Invalid Date", () => {
    const c = decisionConsequence("linkedin_ads.launch_campaign", null, { ...body, end_time: 1e20, total_budget_usd: "lots" });
    expect(c.approve).toBe("Launches “Founders webinar” in LinkedIn Ads. It starts spending as soon as LinkedIn approves the ad.");
  });
});
