import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decisionConsequence } from "./decisionCopy";
import { decisionTitle, handlerPreview } from "./approvalsHelpers";

describe("decisionConsequence — praxis.dispatch_specialist names the target", () => {
  it("names the target agent on approve and reject", () => {
    const c = decisionConsequence(
      "praxis.dispatch_specialist",
      "chief-of-staff.dispatch-specialist",
      { target_agent_slug: "support-lead", intent: "Block the card-testing source." },
    );
    expect(c.approve).toBe(
      "Starts Support Lead on this work now: a real agent run, not a draft.",
    );
    expect(c.reject).toBe("Support Lead is not started. Nothing else changes.");
  });

  it("uses the same label for an unknown slug rather than a raw slug mid-sentence", () => {
    const c = decisionConsequence("praxis.dispatch_specialist", null, {
      target_agent_slug: "brand-new-agent",
    });
    expect(c.approve).toContain("Brand New Agent");
  });

  it("degrades to the generic wording when the body carries no usable target", () => {
    for (const body of [
      {},
      { target_agent_slug: "" },
      { target_agent_slug: { nested: true } },
    ]) {
      const c = decisionConsequence("praxis.dispatch_specialist", null, body);
      expect(c.approve).toBe("Hands the work to the specialist agent to start on.");
      expect(c.reject).toBe("The specialist agent is not dispatched.");
    }
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

  it("names the time when the body carries one", () => {
    const c = decisionConsequence("social.publish.v2", "social.publish.v2", {
      scheduled_at: "2099-01-02T09:00:00.000Z",
    });
    expect(c.approve).toMatch(/^Publishes the post on .*2099|^Publishes the post on .*Jan/);
    expect(c.approve).not.toMatch(/now/);
  });
});

describe("bulk email approval card says nothing is sent", () => {
  it("never promises a bulk send on approve", () => {
    const c = decisionConsequence("bulk_outbound.send", "bulk_outbound.send", {});
    expect(c.approve).not.toMatch(/\bsends the\b|everyone in the list/i);
    expect(c.approve).toMatch(/^Sends nothing\./);
    expect(c.reject).toBe("Nothing is sent — the draft is kept.");
  });

  it("keeps the single-recipient card a real send, so the two never read alike", () => {
    const single = decisionConsequence("outbound.send", "outbound.send", {});
    const bulk = decisionConsequence("bulk_outbound.send", "bulk_outbound.send", {});
    expect(single.approve).toBe("Sends the message.");
    expect(bulk.approve).not.toBe(single.approve);
  });

  it("titles an older bulk draft (no contact list) as a draft, not a send", () => {
    expect(decisionTitle("bulk_outbound.send", { selector: { segment: "lapsed" } })).toEqual({
      agentLabel: "Bulk email",
      verbLabel: "Draft (not sent)",
    });
    expect(decisionTitle("outbound.send").verbLabel).toBe("Send");
  });

  it("a bulk email to a contact list says who it is sent to, from which address", () => {
    const body = {
      list_id: "11111111-1111-4111-8111-111111111111",
      list_version_id: "22222222-2222-4222-8222-222222222222",
      list_name: "Newsletter",
      from_address: "hello@acme.com",
      template: { subject: "Hi", body_text: "Come back." },
      est_recipient_count: 3,
    };
    expect(decisionTitle("bulk_outbound.send", body)).toEqual({ agentLabel: "Bulk email", verbLabel: "Send to a contact list" });
    expect(decisionConsequence("bulk_outbound.send", "bulk_outbound.send", body).approve).toBe(
      "Sends this email to 3 people on Newsletter from hello@acme.com. One email per person. Each email includes an unsubscribe link and your address.",
    );
    expect(decisionTitle("bulk_outbound.send").verbLabel).toBe("To a contact list");
  });
});

describe("bulk email card copy does not depend on the dispatch handler", () => {
  it("still says nothing is sent when the decision row has no handler", () => {
    expect(decisionConsequence(null, "bulk_outbound.send", {}).approve).toMatch(/^Sends nothing\./);
    expect(decisionConsequence("outbound.send", "bulk_outbound.send", {}).approve).toMatch(/^Sends nothing\./);
  });
});

describe("decisionConsequence / handlerPreview: a new Meta ad set names its bid", () => {
  const base = { name: "Grooming, new suburbs", campaign_id: "1200", daily_budget_usd: 40, currency: "USD" };
  const stamped = { ...base, campaign_bid_strategy: "COST_CAP", bid_amount_usd: 32.5, bid_copied_from: { ad_sets: 3, result: "Purchase" } };

  it("says the bid and where it came from", () => {
    expect(decisionConsequence("meta_ads.create_ad_set", "meta_ads.create_ad_set", stamped).approve).toContain(
      "and a cost per result goal of $32.50, picked from the campaign's 3 ad sets for Purchase",
    );
    expect(handlerPreview("meta_ads.create_ad_set", stamped)).toContain("a cost per result goal of $32.50");
  });

  it("must not touch: no bid on the body, no bid in the words", () => {
    expect(decisionConsequence("meta_ads.create_ad_set", "meta_ads.create_ad_set", base).approve).not.toMatch(/goal|bid cap|ROAS/);
    expect(handlerPreview("meta_ads.create_ad_set", base)).not.toMatch(/goal|bid cap|ROAS/);
  });
});

describe("pm.needs_action consequence", () => {
  it("only promises to close a PR when the card has one", () => {
    const withPr = decisionConsequence("pm.needs_action", "pm.needs_action", { exception_kind: "stuck", roadmap_id: "r1", pr_url: "https://github.com/a/b/pull/1" });
    const noPr = decisionConsequence("pm.needs_action", "pm.needs_action", { exception_kind: "stuck", roadmap_id: "r1", pr_url: null });
    expect(withPr.approve).toContain("closes the stale pull request");
    expect(noPr.approve).not.toMatch(/pull request/);
    const badUrl = decisionConsequence("pm.needs_action", "pm.needs_action", { exception_kind: "stuck", roadmap_id: "r1", pr_url: "https://example.com/not-a-pr" });
    expect(badUrl.approve).not.toMatch(/pull request/);
    const huge = decisionConsequence("pm.needs_action", "pm.needs_action", { exception_kind: "stuck", roadmap_id: "r1", pr_url: `https://github.com/a/b/pull/${"9".repeat(400)}` });
    expect(huge.approve).not.toMatch(/pull request/);
    expect(noPr.reject).toBe("Drops it. Nothing is re-run, and Product PM should not propose this item again.");
  });

  it("treats a card with no roadmap target as a heads-up", () => {
    const c = decisionConsequence("pm.needs_action", "pm.needs_action", { theme: "x", roadmap_id: null });
    expect(c.approve).toContain("Nothing is re-run");
  });
});

describe("linkedin_ads.launch_campaign copy", () => {
  const viewerZone = { zone: "UTC" };
  const realLocaleString = Date.prototype.toLocaleString;
  const realLocaleDate = Date.prototype.toLocaleDateString;
  beforeAll(() => {
    Date.prototype.toLocaleString = function (this: Date, locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      return realLocaleString.call(this, locales, { timeZone: viewerZone.zone, ...options });
    };
    Date.prototype.toLocaleDateString = function (this: Date, locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      return realLocaleDate.call(this, locales, { timeZone: viewerZone.zone, ...options });
    };
  });
  afterAll(() => {
    Date.prototype.toLocaleString = realLocaleString;
    Date.prototype.toLocaleDateString = realLocaleDate;
  });
  const body = {
    campaign_binding_id: "8f1c2d7e-1111-4222-8333-444455556666",
    snapshot: "a".repeat(64),
    name: "Founders webinar",
    currency: "USD",
    total_budget_usd: 500,
    end_time: Date.UTC(2026, 10, 12, 12),
    origin: "agent",
    rationale: "Webinar signups from LinkedIn convert best.",
  };

  it.each([
    ["handler", "linkedin_ads.launch_campaign", null],
    ["class only", "linkedin_ads.launch_campaign", "linkedin_ads.launch_campaign"],
  ])("names the campaign, total budget and end date (%s)", (_l, handler, cls) => {
    const c = decisionConsequence(handler, cls, body);
    expect(c.approve).toBe(
      "Launches “Founders webinar” in LinkedIn Ads with a $500 total budget and an end date of Nov 12, 2026, 12:00 PM UTC. It starts spending as soon as LinkedIn approves the ad.",
    );
    expect(c.reject).toBe("“Founders webinar” is not launched and the campaign stays paused. Nothing is spent.");
    expect(c.approve).not.toMatch(/8f1c2d7e|aaaa|campaign_binding|Applies the change/);
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

  it("shows a non-USD account's total in its own currency, as Today and chat do, with the dollar figure beside it", () => {
    const c = decisionConsequence("linkedin_ads.launch_campaign", null, { ...body, currency: "INR", total_budget_cents: 1_660_000, total_budget_usd: 200 });
    expect(c.approve).toBe(
      "Launches “Founders webinar” in LinkedIn Ads with a ₹16,600 (about $200) total budget and an end date of Nov 12, 2026, 12:00 PM UTC. It starts spending as soon as LinkedIn approves the ad.",
    );
  });

  it.each(["America/New_York", "Asia/Kolkata", "Pacific/Auckland", "UTC"])("Flow 46: shows the same UTC end day and time as the channel card for a viewer in %s", (zone) => {
    viewerZone.zone = zone;
    try {
      const c = decisionConsequence("linkedin_ads.launch_campaign", null, { ...body, end_time: Date.UTC(2026, 10, 10, 23, 30) });
      expect(c.approve).toContain("an end date of Nov 10, 2026, 11:30 PM UTC.");
      expect(c.approve).not.toContain("Nov 11");
    } finally {
      viewerZone.zone = "UTC";
    }
  });

  it("ignores a non-finite end time", () => {
    const c = decisionConsequence("linkedin_ads.launch_campaign", null, { ...body, end_time: "soon" });
    expect(c.approve).not.toContain("end date");
    expect(c.approve).not.toContain("Invalid");
  });

  it.each([
    [1234.5, "$1,234.50"],
    [500, "$500"],
    [5000, "$5,000"],
    [99.99, "$99.99"],
    [0.5, "$0.50"],
  ])("shows a total budget of %s as %s", (total, shown) => {
    const c = decisionConsequence("linkedin_ads.launch_campaign", null, { ...body, total_budget_usd: total });
    expect(c.approve).toBe(
      `Launches “Founders webinar” in LinkedIn Ads with a ${shown} total budget and an end date of Nov 12, 2026, 12:00 PM UTC. It starts spending as soon as LinkedIn approves the ad.`,
    );
  });
});

describe("linkedin_ads.create_campaign_bundle copy", () => {
  it("sends the founder to Review launch in Zavi, not to Campaign Manager", () => {
    const c = decisionConsequence("linkedin_ads.create_campaign_bundle", null, { name: "Spring" });
    expect(c.approve).toContain("Review launch on your LinkedIn Ads page in Zavi");
    expect(c.approve).not.toMatch(/until you turn it on in Campaign Manager/);
  });
});
