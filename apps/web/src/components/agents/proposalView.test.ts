import { describe, it, expect } from "vitest";
import {
  parseProposalView,
  extractRoas,
  extractPurchaseN,
  firstSentence,
  modifyPlaceholder,
  modifyQuickReplies,
} from "./proposalView";
import { handlerPreview } from "@/app/approvals/approvalsHelpers";

describe("proposal card name + about (which campaign + what it is)", () => {
  it("parseProposalView surfaces body.about", () => {
    const v = parseProposalView("meta_ads.set_status", "meta_ads.set_status", {
      object_id: "120",
      level: "campaign",
      status: "PAUSED",
      rationale: "0.54x ROAS",
      name: "Bay Area Rentals",
      about: "Purchase campaign for the SF/Bay Area rental audience.",
    });
    expect(v.about).toBe("Purchase campaign for the SF/Bay Area rental audience.");
  });

  it("handlerPreview shows the NAME when present (status + budget)", () => {
    expect(
      handlerPreview("meta_ads.set_status", {
        object_id: "120",
        level: "campaign",
        name: "Bay Area Rentals",
      }),
    ).toContain("Bay Area Rentals");
    expect(
      handlerPreview("meta_ads.update_ad_set_budget", {
        ad_set_id: "as1",
        name: "Gig Rentals Purchase",
        expected_current_daily_budget_usd: 30,
        daily_budget_usd: 36,
      }),
    ).toContain("Gig Rentals Purchase");
  });

  it("handlerPreview falls back to the raw id when name is absent (back-compat)", () => {
    const p = handlerPreview("meta_ads.set_status", {
      object_id: "120253835415120059",
      level: "campaign",
    });
    expect(p).toContain("120253835415120059");
    expect(p).toContain("campaign");
  });
});

const budgetBody = (
  from: number,
  to: number,
  rationale: string,
): Record<string, unknown> => ({
  ad_set_id: "x",
  expected_current_daily_budget_usd: from,
  daily_budget_usd: to,
  rationale,
});
const raiseChips = (from: number, to: number, rationale: string) =>
  parseProposalView(
    "meta_ads.update_ad_set_budget",
    "meta_ads.update_ad_set_budget",
    budgetBody(from, to, rationale),
  ).chips;

describe("extractRoas", () => {
  it("mines '0.32x ROAS'", () => {
    expect(extractRoas("only 0.32x ROAS, a money leak")).toBe(0.32);
  });
  it("mines '27× ROAS' (unicode times)", () => {
    expect(extractRoas("best performer at 27× ROAS over 30d")).toBe(27);
  });
  it("mines 'ROAS 1.95x' (number after)", () => {
    expect(extractRoas("ROAS 1.95x over 14d")).toBe(1.95);
  });
  it("mines 'ROAS of 2.2'", () => {
    expect(extractRoas("delivering ROAS of 2.2 last week")).toBe(2.2);
  });
  it("returns null when absent", () => {
    expect(extractRoas("no return-on-ad-spend figure here")).toBeNull();
  });
  it("ignores implausible values", () => {
    expect(extractRoas("9999x ROAS")).toBeNull();
  });
});

describe("firstSentence", () => {
  it("takes up to the first period", () => {
    expect(firstSentence("Pause it. It loses money. Badly.")).toBe(
      "Pause it.",
    );
  });
  it("hard-caps a run-on with no break", () => {
    const long = "x".repeat(200);
    const lead = firstSentence(long, 50)!;
    expect(lead.length).toBeLessThanOrEqual(50);
    expect(lead.endsWith("…")).toBe(true);
  });
  it("returns null on empty", () => {
    expect(firstSentence(null)).toBeNull();
    expect(firstSentence("   ")).toBeNull();
  });
});

describe("parseProposalView — meta_ads", () => {
  it("PAUSE campaign → plain action + ROAS chip + collapsible reasoning", () => {
    const body = {
      object_id: "120252797318090059",
      level: "campaign",
      status: "PAUSED",
      rationale:
        "30-day data: only 0.32x ROAS. Zero purchases in the last 7 days. Single largest spend leak in the account.",
    };
    const v = parseProposalView("meta_ads.set_status", "meta_ads.set_status", body);
    expect(v.action).toBe("Pause campaign 120252797318090059");
    expect(v.target).toContain("120252797318090059");
    expect(v.chips).toContainEqual({ label: "0.32× ROAS", tone: "bad" });
    expect(v.lead).toBe("30-day data: only 0.32x ROAS.");
    expect(v.full).toBe(body.rationale);
  });

  it("budget increase → names the ad set and both amounts + exact +$/day delta chip", () => {
    const body = {
      ad_set_id: "120252798122740059",
      expected_current_daily_budget_usd: 72,
      daily_budget_usd: 120,
      rationale: "Best performer at 27x ROAS. Redirect budget from a loser.",
    };
    const v = parseProposalView(
      "meta_ads.update_ad_set_budget",
      "meta_ads.update_ad_set_budget",
      body,
    );
    expect(v.action).toBe("Raise ad set 120252798122740059 from $72 to $120 a day");
    expect(v.chips).toContainEqual({ label: "+$48/day", tone: "neutral" });
    expect(v.chips).toContainEqual({ label: "27× ROAS", tone: "good" });
  });

  it("budget decrease uses a minus sign", () => {
    const body = {
      ad_set_id: "x",
      expected_current_daily_budget_usd: 100,
      daily_budget_usd: 40,
      rationale: "trim",
    };
    const v = parseProposalView(
      "meta_ads.update_ad_set_budget",
      "meta_ads.update_ad_set_budget",
      body,
    );
    expect(v.action).toBe("Cut ad set x from $100 to $40 a day");
    expect(v.chips[0].label).toBe("−$60/day");
  });

  it("create_ad_set → 'Launch a new ad set'", () => {
    const v = parseProposalView("meta_ads.create_ad_set", "meta_ads.create_ad_set", {
      campaign_id: "c1",
      name: "Vans SF",
      daily_budget_usd: 15,
      rationale: "new wedge",
    });
    expect(v.action).toBe("Launch a new ad set");
  });
});

describe("parseProposalView — generic + evidence", () => {
  it("unknown handler falls back to verb label, never throws", () => {
    const v = parseProposalView("support-lead.send-reply", "gmail.send", {
      to: "user@example.com",
      subject: "Re: refund",
      rationale: "Customer asked for status. Replying with the tracking link.",
    });
    expect(v.action).toBe("Send an email");
    expect(v.lead).toBe("Customer asked for status.");
  });

  it("renders decision_evidence blast + confidence chips and prefers reason_text as lead", () => {
    const v = parseProposalView("dispute-response.submit-evidence", "stripe.refund", {
      amount: 4930,
      currency: "usd",
      rationale: "long rationale prose that should sit behind Why",
      decision_evidence: {
        reason_text: "Guest reported a no-show; evidence supports the chargeback.",
        evidence: ["trip log", "messages"],
        alternatives_considered: [],
        reversibility: "irreversible",
        blast_radius: "RED",
        confidence: 0.82,
      },
    });
    expect(v.action).toBe("Issue a refund");
    expect(v.lead).toBe(
      "Guest reported a no-show; evidence supports the chargeback.",
    );
    expect(v.chips).toContainEqual({ label: "red", tone: "bad" });
    expect(v.chips).toContainEqual({ label: "82% sure", tone: "neutral" });
  });

  it("handles a malformed (non-object) body without throwing", () => {
    // @ts-expect-error — deliberately passing a bad shape
    const v = parseProposalView("x.y", null, "not an object");
    expect(v.action).toBeTruthy();
    expect(v.chips).toEqual([]);
  });

  it("omits 'full' when the rationale is just the lead (no redundant Why)", () => {
    const v = parseProposalView("meta_ads.set_status", "meta_ads.set_status", {
      object_id: "z",
      level: "adset",
      status: "ACTIVE",
      rationale: "Resume the proven winner.",
    });
    expect(v.action).toBe("Turn on ad set z");
    expect(v.lead).toBe("Resume the proven winner.");
    expect(v.full).toBeNull();
  });
});

describe("modify helpers", () => {
  it("returns budget-raise specific quick replies and placeholder", () => {
    const body = {
      ad_set_id: "x",
      expected_current_daily_budget_usd: 50,
      daily_budget_usd: 100,
    };
    expect(
      modifyQuickReplies("meta_ads.update_ad_set_budget", "meta_ads.update_ad_set_budget", body),
    ).toEqual(["Raise less", "Delay 3 days", "Cap at current", "Ask why"]);
    expect(
      modifyPlaceholder("meta_ads.update_ad_set_budget", "meta_ads.update_ad_set_budget", body),
    ).toContain("$70/day");
  });

  it("returns pause-specific quick replies", () => {
    expect(
      modifyQuickReplies("meta_ads.set_status", "meta_ads.set_status", {
        level: "campaign",
        status: "PAUSED",
      }),
    ).toEqual(["Lower budget instead", "Delay 3 days", "Ask why", "Reject and monitor"]);
  });
});

describe("extractPurchaseN", () => {
  it("mines 'n=21'", () => expect(extractPurchaseN("strong at n=21, 30d")).toBe(21));
  it("mines 'n = 2'", () => expect(extractPurchaseN("only n = 2")).toBe(2));
  it("mines '21 purchases'", () =>
    expect(extractPurchaseN("21 purchases over 30d")).toBe(21));
  it("mines '1 purchase' (singular)", () =>
    expect(extractPurchaseN("1 purchase in 7 days")).toBe(1));
  it("returns null when absent", () =>
    expect(extractPurchaseN("best performer, 27x ROAS")).toBeNull());
  it("returns null on empty", () => expect(extractPurchaseN(null)).toBeNull());
});

describe("parseProposalView — raise confidence badge", () => {
  it("high-confidence chip when n≥10, no step warning at ≤30%", () => {
    const chips = raiseChips(72, 90, "Top line at 20x ROAS on n=21, 30d.");
    expect(chips).toContainEqual({ label: "high-confidence", tone: "good" });
    expect(chips).not.toContainEqual({ label: ">30% step", tone: "warn" });
    expect(chips).not.toContainEqual({ label: "speculative-test", tone: "warn" });
  });

  it("speculative-test + >30% step on a thin-sample big jump", () => {
    const chips = raiseChips(30, 90, "23x ROAS on n=2.");
    expect(chips).toContainEqual({ label: ">30% step", tone: "warn" });
    expect(chips).toContainEqual({ label: "speculative-test", tone: "warn" });
  });

  it("speculative-test when n absent (no false high-confidence)", () => {
    const chips = raiseChips(72, 90, "Best performer at 27x ROAS.");
    expect(chips).toContainEqual({ label: "speculative-test", tone: "warn" });
    expect(chips).not.toContainEqual({ label: "high-confidence", tone: "good" });
  });

  it("no >30% step chip on a tiny-budget nudge (+$10/day floor)", () => {
    const chips = raiseChips(2, 12, "Test bump, n=15.");
    expect(chips).not.toContainEqual({ label: ">30% step", tone: "warn" });
    expect(chips).toContainEqual({ label: "high-confidence", tone: "good" });
  });

  it("a budget DECREASE gets neither raise chip", () => {
    const chips = raiseChips(100, 40, "trim a loser, n=3");
    expect(chips).not.toContainEqual({ label: ">30% step", tone: "warn" });
    expect(chips).not.toContainEqual({ label: "speculative-test", tone: "warn" });
    expect(chips).not.toContainEqual({ label: "high-confidence", tone: "good" });
    expect(chips[0].label).toBe("−$60/day");
  });
});

describe("Composio write card (spec 12): app, plain action, every field, red labels", () => {
  it("composio write: app + plain action, every argument as a field, red money/delete chips", () => {
    const v = parseProposalView("composio.moves_money", "composio.execute_tool", {
      kind: "composio_write", app_name: "Square", action: "Create refund", tool_slug: "SQUARE_CREATE_REFUND",
      arguments: { charge: "ch_1", amount: 500, metadata: { reason: "dup" } }, labels: ["moves_money", "deletes_data"],
    });
    expect(v.action).toBe("Square: Create refund");
    expect(v.fields).toEqual([
      { label: "charge", value: "ch_1" }, { label: "amount", value: "500" }, { label: "metadata", value: '{"reason":"dup"}' },
    ]);
    expect(v.chips.slice(0, 2)).toEqual([{ label: "Moves money", tone: "bad" }, { label: "Deletes data", tone: "bad" }]);
  });
  it("composio field values are deterministic for every JSON shape (never 'undefined')", () => {
    const v = parseProposalView("composio.write", "composio.execute_tool", {
      kind: "composio_write", app_name: "Gmail", action: "Send email", tool_slug: "GMAIL_SEND_EMAIL", labels: [],
      arguments: { a: null, b: undefined, c: [1, "x"], d: { z: 1, y: { k: true } }, e: "line1\nline2", f: "x".repeat(5000), g: false, h: "" },
    });
    expect(v.fields).toEqual([
      { label: "a", value: "null" }, { label: "b", value: "(empty)" }, { label: "c", value: '[1,"x"]' },
      { label: "d", value: '{"y":{"k":true},"z":1}' }, { label: "e", value: "line1\nline2" }, { label: "f", value: "x".repeat(5000) },
      { label: "g", value: "false" }, { label: "h", value: "" },
    ]);
    expect(v.fields.some((f) => f.value.includes("undefined"))).toBe(false);
  });
  it("a plain write has no red chips; the action falls back to the tool slug", () => {
    const v = parseProposalView("composio.write", "composio.execute_tool", {
      kind: "composio_write", tool_slug: "NOTION_CREATE_PAGE", arguments: {}, labels: [],
    });
    expect(v.action).toBe("App: NOTION_CREATE_PAGE");
    expect(v.chips.some((c) => c.tone === "bad")).toBe(false);
    expect(v.fields).toEqual([]);
  });
  it("a TikTok Ads write names the ad account it goes to as the first field", () => {
    const v = parseProposalView("composio.moves_money", "composio.execute_tool", {
      kind: "composio_write", app_name: "TikTok Ads", action: "Update campaign budget", tool_slug: "TIKTOK_ADS_UPDATE_CAMPAIGN_BUDGET",
      arguments: { advertiser_id: "7683915592165785621", budget: 50 }, labels: ["moves_money"],
      ad_account: { advertiser_id: "7683915592165785621", name: "ZAVI main" },
    });
    expect(v.fields).toEqual([
      { label: "Ad account", value: "ZAVI main (ID 7683915592165785621)" }, { label: "budget", value: "50" },
    ]);
  });
  it("the ad account field shows the ID that is actually sent, never a mismatched display name", () => {
    const v = parseProposalView("composio.moves_money", "composio.execute_tool", {
      kind: "composio_write", app_name: "TikTok Ads", action: "Pause campaign", tool_slug: "TIKTOK_ADS_UPDATE_CAMPAIGN_STATUS",
      arguments: { advertiser_id: "111111" }, labels: ["moves_money"],
      ad_account: { advertiser_id: "222222", name: "Other brand" },
    });
    expect(v.fields).toEqual([{ label: "Ad account", value: "ID 111111" }]);
  });
  it("non-composio proposals get fields: []", () => {
    expect(parseProposalView("send_email", "email.send", {}).fields).toEqual([]);
  });

  it("an email card shows Reply-To when it is set", () => {
    expect(
      parseProposalView("send_email", "gmail.send", { to: "a@b.co", reply_to: "c@d.co", subject: "S", body_text: "M" }).fields.map((f) => f.label),
    ).toEqual(["To", "Reply-To", "Subject", "Message"]);
  });

  it("an email card shows the exact message: To, Subject, Message (exact-action approvals)", () => {
    const body = { to: "jane@acme.test", subject: "Your refund", body_text: "Hi Jane,\nyour refund is on its way." };
    for (const handler of ["gmail.send", "email.send"]) {
      expect(parseProposalView("send_email", handler, body).fields).toEqual([
        { label: "To", value: "jane@acme.test" },
        { label: "Subject", value: "Your refund" },
        { label: "Message", value: "Hi Jane,\nyour refund is on its way." },
      ]);
    }
  });
  it("handlerPreview names the app and action", () => {
    expect(handlerPreview("composio.execute_tool", { app_name: "Square", action: "Create refund" })).toBe("→ Square · Create refund");
  });
});

describe("exact-action cards filed by the governance chokepoint", () => {
  it("a charge shows its amount and fee, leading with Moves money", () => {
    const v = parseProposalView("stripe.create_payment", "stripe.create_payment", {
      amount: 1999, currency: "usd", application_fee_amount: 100, client_reference: "order-7", governed_by: "chokepoint",
    });
    expect(v.fields).toEqual([
      { label: "Charge", value: "19.99 USD" },
      { label: "Zavi fee", value: "1.00 USD" },
      { label: "Reference", value: "order-7" },
    ]);
    expect(v.chips[0]).toEqual({ label: "Moves money", tone: "bad" });
  });

  it("a pull request lists its files; a merge states its conditions", () => {
    const pr = parseProposalView("github.open_pr_direct", "github.open_pr", {
      repo: "acme/web", base_branch: "main", head_branch: "engineer/fix", title: "Fix", governed_by: "chokepoint",
      files: [{ path: "a.ts", action: "modify", content: "x\ny" }],
    });
    expect(pr.fields.find((f) => f.label === "Files")?.value).toBe("a.ts (modify, 2 lines)");
    const merge = parseProposalView("github.merge_pr_direct", "github.merge_pr", {
      owner: "acme", repo: "web", pull_number: 12, commit_title: "Fix", governed_by: "chokepoint",
    });
    expect(merge.fields.map((f) => f.label)).toEqual(["Repo", "Pull request", "Commit title", "Merges only if"]);
  });

  it("a card another flow emitted for the same class is unchanged", () => {
    expect(parseProposalView("create_jira_issue", "jira.create_issue", { project_key: "OPS", summary: "s" }).fields).toEqual([]);
  });
});

describe("a campaign send through the founder's email tool, proposed in chat", () => {
  const body = {
    tool: "mailchimp", connected_account_id: "ca", auth_config_id: "ac", audience_id: "L1", audience_name: "Newsletter", audience_count: 1412, approved_count: 1412,
    subject: "Spring offer", preview_text: "Two weeks only", body_text: "Hello", from_name: "Acme", from_email: "hi@acme.test", reply_to: null,
  };

  it("shows the subject, the preview, the tool, the list, the number of people and the message", () => {
    const v = parseProposalView("email_campaign.create_and_send", "email_campaign.create_and_send", body);
    expect(v.action).toBe("Send an email to a list");
    expect(v.fields).toEqual([
      { label: "Subject", value: "Spring offer" },
      { label: "Preview", value: "Two weeks only" },
      { label: "From", value: "Acme <hi@acme.test>" },
      { label: "Sending with", value: "Mailchimp" },
      { label: "List", value: "Newsletter" },
      { label: "People", value: "1,412" },
      { label: "Message", value: "Hello" },
    ]);
    expect(JSON.stringify(v.fields)).not.toMatch(/ca\b|<p>/);
  });

  it("is shown and approved from the full card, with its own title", async () => {
    const { isExactActionCard, decisionTitle, outcomeAppName } = await import("@/app/approvals/approvalsHelpers");
    expect(isExactActionCard("email_campaign.create_and_send", body)).toBe(true);
    expect(isExactActionCard("email_campaign.create_and_send", { subject: "x" })).toBe(false);
    expect(decisionTitle("email_campaign.create_and_send")).toEqual({ agentLabel: "Email campaign", verbLabel: "Send to a list" });
    expect(outcomeAppName("email_campaign.create_and_send", { ...body, tool: "klaviyo" })).toBe("Klaviyo");
  });
});

describe("money amounts use the currency's own decimal places", () => {
  it("three-decimal, zero-decimal and two-decimal currencies", async () => {
    const { formatMinor } = await import("./exactActionFields");
    expect(formatMinor(1000, "kwd")).toBe("1.000 KWD");
    expect(formatMinor(1000, "jpy")).toBe("1000 JPY");
    expect(formatMinor(1000, "usd")).toBe("10.00 USD");
    expect(formatMinor(500, "ugx")).toBe("5.00 UGX");
  });
});
