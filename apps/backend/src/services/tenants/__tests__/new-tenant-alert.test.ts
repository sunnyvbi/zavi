import { describe, it, expect, vi } from "vitest";

import {
  parseWizardAnswers,
  signalLine,
  planFromSubscription,
  formatCreatedPt,
  notifyNewTenant,
  isPlaceholderBrainBody,
  renderNewTenantEmail,
  alertRecipient,
  clip,
  stripHeadingMarkers,
  DOGFOOD_SLUGS,
  type TenantSummary,
} from "../new-tenant-alert";

type Row = Record<string, unknown>;

function fakeClient(tables: Record<string, Row[]>, ownerEmail: string | null = "founder@acme.com") {
  const builder = (rows: Row[]) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit"]) {
      b[m] = () => b;
    }
    b.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
    return b;
  };
  return {
    from: (table: string) => builder(tables[table] ?? []),
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { email: ownerEmail } }, error: null }),
      },
    },
  };
}

function deps<T extends object>(over: T = {} as T) {
  return {
    sgSend: vi.fn(async (_to: string, _subject: string, _html: string, _text: string) => {}),
    serviceClient: () => fakeClient({}),
    getBoolSetting: vi.fn(async () => false),
    signupAlertsEnabled: async () => true,
    setTenantSetting: vi.fn(async () => {}),
    armFollowup: vi.fn(async () => {}),
    ...over,
  };
}

const REAL_TENANT: Row = {
  id: "t1",
  slug: "acme",
  display_name: "Acme Rentals",
  created_at: "2026-09-05T10:00:00Z",
  kind: "real",
  tier: "free",
  company_shape: "marketplace",
  product_url: { marketing: "https://acme.com" },
};

describe("notifyNewTenant — who gets an email", () => {
  it("sends for a real tenant and flips the idempotency flag after the send", async () => {
    const d = deps({
      serviceClient: () =>
        fakeClient({
          tenants: [REAL_TENANT],
          memory_note: [{ slug: "company", title: "Company", body_markdown: "P2P car rental." }],
          autopilot_goals: [{ objective: "More bookings", target_metric: "bookings", target_value: 100 }],
          tenant_app_setting: [{ key: "build_app_intent", value: "existing" }],
        }),
    });
    const out = await notifyNewTenant({ tenant_id: "t1", user_id: "u1", path: "wizard" }, d);

    expect(out).toEqual({ sent: true });
    expect(d.sgSend).toHaveBeenCalledTimes(1);
    const [to, subject, , text] = d.sgSend.mock.calls[0];
    expect(to).toBe(alertRecipient());
    expect(subject).toContain("Acme Rentals");
    expect(subject).toContain("founder@acme.com");
    expect(text).toContain("P2P car rental.");
    expect(text).toContain("More bookings");
    expect(d.setTenantSetting).toHaveBeenCalledWith("t1", "new_tenant_alert_sent", true, "u1");
  });

  it("skips a tenant already alerted (activate is retry-safe and re-enters)", async () => {
    const d = deps({ getBoolSetting: vi.fn(async () => true) });
    const out = await notifyNewTenant({ tenant_id: "t1", user_id: "u1", path: "wizard" }, d);
    expect(out).toEqual({ sent: false, reason: "already_sent" });
    expect(d.sgSend).not.toHaveBeenCalled();
  });

  it("skips kind='test' tenants — the QA harness creates throwaways constantly", async () => {
    const d = deps({
      serviceClient: () => fakeClient({ tenants: [{ ...REAL_TENANT, kind: "test" }] }),
    });
    const out = await notifyNewTenant({ tenant_id: "t1", user_id: "u1", path: "wizard" }, d);
    expect(out).toEqual({ sent: false, reason: "skipped_test_tenant" });
    expect(d.sgSend).not.toHaveBeenCalled();
  });

  it("skips the dogfood slugs", async () => {
    for (const slug of DOGFOOD_SLUGS) {
      const d = deps({
        serviceClient: () => fakeClient({ tenants: [{ ...REAL_TENANT, slug }] }),
      });
      const out = await notifyNewTenant({ tenant_id: "t1", user_id: "u1", path: "wizard" }, d);
      expect(out).toEqual({ sent: false, reason: "skipped_dogfood_tenant" });
      expect(d.sgSend).not.toHaveBeenCalled();
    }
  });
});

describe("notifyNewTenant — failure containment", () => {
  it("never throws when the send fails, and leaves the flag unset so a retry re-attempts", async () => {
    const d = deps({
      serviceClient: () => fakeClient({ tenants: [REAL_TENANT] }),
      sgSend: vi.fn(async () => {
        throw new Error("sendgrid 503");
      }),
    });
    const out = await notifyNewTenant({ tenant_id: "t1", user_id: "u1", path: "wizard" }, d);
    expect(out).toEqual({ sent: false, reason: "sendgrid 503" });
    expect(d.setTenantSetting).not.toHaveBeenCalled();
  });

  it("returns a reason instead of throwing when the tenant row is gone", async () => {
    const d = deps({ serviceClient: () => fakeClient({ tenants: [] }) });
    const out = await notifyNewTenant({ tenant_id: "t1", user_id: "u1", path: "wizard" }, d);
    expect(out).toEqual({ sent: false, reason: "tenant_not_found" });
  });
});

describe("renderNewTenantEmail", () => {
  const base: TenantSummary = {
    tenant_id: "t1",
    slug: "acme",
    display_name: "Acme Rentals",
    path: "wizard",
    created_at: "2026-09-05T10:00:00Z",
    owner_email: "founder@acme.com",
    user_id: "u1",
    tier: "free",
    company_shape: "marketplace",
    product_url: "https://acme.com",
    build_app_intent: "existing",
    company_scale_segment: "smb",
    goal: null,
    brain: [],
    typed_facts: {},
    generated_story: null,
    growth: [],
    unanswered_growth: ["gtm_growth", "metrics_north_star"],
  };

  it("says nothing was typed rather than rendering a blank section", () => {
    const { text } = renderNewTenantEmail(base);
    expect(text).toContain("nothing typed");
    expect(text).toContain("came in on the build path");
  });

  it("prints the founder's own words and NOT the onboarding rewrite of them", () => {
    const { text } = renderNewTenantEmail({
      ...base,
      typed_facts: { company_story: "We rent cars between neighbours.", what_we_sell: "Car rental." },
      brain: [{ slug: "company", title: "Company", body: "A peer-to-peer mobility marketplace." }],
    });
    expect(text).toContain("In their words");
    expect(text).toContain("We rent cars between neighbours.");
    expect(text).not.toContain("A peer-to-peer mobility marketplace.");
    expect(text).not.toContain("Car rental.");
  });

  it("labels the fallback as generated when the founder typed nothing", () => {
    const { text } = renderNewTenantEmail({
      ...base,
      typed_facts: {},
      brain: [{ slug: "company", title: "Company", body: "A peer-to-peer mobility marketplace." }],
    });
    expect(text).toContain("written by onboarding, not typed by them");
    expect(text).toContain("A peer-to-peer mobility marketplace.");
  });

  it("does NOT quote an ai_estimated company_story as the founder's words", () => {
    const { text } = renderNewTenantEmail({
      ...base,
      typed_facts: {},
      generated_story: "A peer-to-peer mobility marketplace.",
    });
    expect(text).toContain("written by onboarding, not typed by them");
    expect(text).toContain("A peer-to-peer mobility marketplace.");
    expect(text).not.toContain("## In their words");
  });

  it("prefers the generated story over the dropped company anchor", () => {
    const { text } = renderNewTenantEmail({
      ...base,
      typed_facts: {},
      generated_story: "From the story fact.",
      brain: [{ slug: "company", title: "Company", body: "From the anchor." }],
    });
    expect(text).toContain("From the story fact.");
    expect(text).not.toContain("From the anchor.");
  });

  it("does not put a generated story under an in-their-own-words banner", () => {
    const { text, html } = renderNewTenantEmail({
      ...base,
      typed_facts: {},
      generated_story: "# Company\n\nA peer-to-peer mobility marketplace.",
    });
    expect(text).not.toContain("in their own words");
    expect(text).toContain("not typed by them");
    expect(html).not.toContain("in their own words");
    expect(text).toContain("A peer-to-peer mobility marketplace.");
    expect(text).not.toContain("Company A peer-to-peer");
  });

  it("uses the quote banner only when the founder actually typed it", () => {
    const { text } = renderNewTenantEmail({
      ...base,
      typed_facts: { company_story: "We rent cars between neighbours." },
    });
    expect(text).toContain("in their own words");
  });

  it("labels enrichment-sourced competitors as ours, not theirs", () => {
    const { text } = renderNewTenantEmail({
      ...base,
      typed_facts: { company_story: "We rent cars.", competitors: "Turo, Getaround" },
    });
    expect(text).toContain("found by our enrichment, not stated by them");
    expect(text).toContain("Turo, Getaround");
  });

  it("names an unanswered growth question instead of hiding it", () => {
    const { text } = renderNewTenantEmail(base);
    expect(text).toContain("How they get customers");
    expect(text).toContain("North-star metric");
    expect(text.match(/\(not answered\)/g) ?? []).toHaveLength(2);
    expect(text).toContain("(not set)");
  });

  it("prints a growth answer when the operator gave one", () => {
    const { text } = renderNewTenantEmail({
      ...base,
      growth: [{ slug: "gtm_growth", title: "How they get customers", body: "Referrals and local SEO." }],
      unanswered_growth: ["metrics_north_star"],
    });
    expect(text).toContain("Referrals and local SEO.");
    expect(text.match(/\(not answered\)/g) ?? []).toHaveLength(1);
  });

  it("escapes HTML from operator-supplied company text", () => {
    const { html } = renderNewTenantEmail({
      ...base,
      display_name: '<script>alert(1)</script>',
      brain: [{ slug: "company", title: "Company", body: "<img onerror=x>" }],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes HTML from the founder's typed facts — a new untrusted surface", () => {
    const { html } = renderNewTenantEmail({
      ...base,
      typed_facts: { company_story: "<img src=x onerror=alert(1)>", competitors: "<b>Turo</b>" },
    });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>Turo</b>");
    expect(html).toContain("&lt;img src=x");
  });

  it("labels the build path differently from the wizard path", () => {
    expect(renderNewTenantEmail({ ...base, path: "build_start" }).text).toContain("Build an app");
    expect(renderNewTenantEmail(base).text).toContain("Grow wizard");
  });
});

describe("what the alert reads from the brain", () => {
  it("never prints the support-desk anchors, even when they are full of prose", async () => {
    const d = deps({
      serviceClient: () =>
        fakeClient({
          tenants: [REAL_TENANT],
          memory_note: [
            { slug: "company", title: "company.md", body_markdown: "# Company\nP2P car rental." },
            { slug: "ops", title: "ops.md", body_markdown: "# Ops\nPayment cap is $5K per transaction." },
            { slug: "policies", title: "policies.md", body_markdown: "# Policies\nRefunds within 24 hours." },
            { slug: "disputes", title: "disputes.md", body_markdown: "# Disputes\nWe refund at 100%." },
            { slug: "support", title: "support.md", body_markdown: "# Support\nTier 1 within 2 hours." },
          ],
          tenant_fact: [{ key: "company_story", value_text: "We rent cars between neighbours." }],
        }),
    });
    await notifyNewTenant({ tenant_id: "t1", user_id: "u1", path: "wizard" }, d);
    const text = d.sgSend.mock.calls[0][3] as string;

    expect(text).toContain("We rent cars between neighbours.");
    for (const leaked of [
      "Payment cap is $5K",
      "Refunds within 24 hours",
      "We refund at 100%",
      "Tier 1 within 2 hours",
    ]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("treats an unedited growth stub as unanswered, not as an answer", async () => {
    const d = deps({
      serviceClient: () =>
        fakeClient({
          tenants: [REAL_TENANT],
          memory_note: [
            {
              slug: "gtm_growth",
              title: "gtm_growth.md",
              body_markdown: "# Go-to-market\n_(Set this up — tell your agents how you get customers.)_",
            },
          ],
        }),
    });
    await notifyNewTenant({ tenant_id: "t1", user_id: "u1", path: "wizard" }, d);
    const text = d.sgSend.mock.calls[0][3] as string;

    expect(text).not.toContain("Set this up");
    expect(text).toContain("How they get customers");
    expect(text).toContain("(not answered)");
  });

  it("reads the fact SOURCE, so a model-written story is not quoted as theirs", async () => {
    const d = deps({
      serviceClient: () =>
        fakeClient({
          tenants: [REAL_TENANT],
          tenant_fact: [
            { key: "company_story", value_text: "A peer-to-peer mobility marketplace.", source: "ai_estimated" },
          ],
        }),
    });
    await notifyNewTenant({ tenant_id: "t1", user_id: "u1", path: "wizard" }, d);
    const text = d.sgSend.mock.calls[0][3] as string;

    expect(text).toContain("written by onboarding, not typed by them");
    expect(text).not.toContain("## In their words");
    expect(text).toContain("A peer-to-peer mobility marketplace.");
  });

  it("quotes the story when the source says the founder typed it", async () => {
    const d = deps({
      serviceClient: () =>
        fakeClient({
          tenants: [REAL_TENANT],
          tenant_fact: [
            { key: "company_story", value_text: "We rent cars between neighbours.", source: "human_confirmed" },
          ],
        }),
    });
    await notifyNewTenant({ tenant_id: "t1", user_id: "u1", path: "wizard" }, d);
    const text = d.sgSend.mock.calls[0][3] as string;

    expect(text).toContain("## In their words");
    expect(text).toContain("We rent cars between neighbours.");
    expect(text).not.toContain("written by onboarding");
  });

  it("does not send, and does not burn the idempotency flag, on a fact read error", async () => {
    const failing = {
      from: (table: string) => {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "order", "limit"]) b[m] = () => b;
        b.maybeSingle = async () => ({ data: table === "tenants" ? REAL_TENANT : null, error: null });
        b.then = (resolve: (v: unknown) => unknown) =>
          resolve(
            table === "tenant_fact"
              ? { data: null, error: { message: "boom" } }
              : { data: [], error: null },
          );
        return b;
      },
      auth: { admin: { getUserById: async () => ({ data: { user: { email: "f@a.com" } }, error: null }) } },
    };
    const d = deps({ serviceClient: () => failing });
    const out = await notifyNewTenant({ tenant_id: "t1", user_id: "u1", path: "wizard" }, d);

    expect(out.sent).toBe(false);
    expect(d.sgSend).not.toHaveBeenCalled();
    expect(d.setTenantSetting).not.toHaveBeenCalled();
  });

  it("still sends for a tenant with no typed facts and no growth anchors", async () => {
    const d = deps({ serviceClient: () => fakeClient({ tenants: [REAL_TENANT] }) });
    const out = await notifyNewTenant({ tenant_id: "t1", user_id: "u1", path: "build_start" }, d);

    expect(out).toEqual({ sent: true });
    const text = d.sgSend.mock.calls[0][3] as string;
    expect(text).toContain("nothing typed");
    expect(text).toContain("(not answered)");
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it("recognises both stock placeholder templates", () => {
    expect(isPlaceholderBrainBody("We haven't written this. Edit this anchor to add: x")).toBe(true);
    expect(isPlaceholderBrainBody("_(Set this up — tell your agents about your pricing.)_")).toBe(true);
    expect(isPlaceholderBrainBody("Spend caps: not yet defined, operator to set.")).toBe(false);
  });
});

describe("clip", () => {
  it("drops a leading heading that is separated by a blank line", () => {
    expect(clip("# Company\n\nWe rent cars.")).toBe("We rent cars.");
  });

  it("keeps interior heading text without its markers", () => {
    expect(clip("# Growth\n\n## Constraint\nDiscovery.\n## Channels\n- seo")).toBe(
      "Constraint Discovery. Channels - seo",
    );
  });

  it("does not empty a body that is only a heading", () => {
    expect(clip("## Channels we are betting on")).toBe("Channels we are betting on");
  });

  it("does not eat a first line that merely starts with a hash", () => {
    expect(clip("#1 priority is retention\nmore text")).toBe("#1 priority is retention more text");
    expect(clip("#growth is the goal\nmore")).toBe("#growth is the goal more");
  });

  it("still drops a real leading heading", () => {
    expect(clip("## Company\nP2P car rental.")).toBe("P2P car rental.");
  });
});

describe("stripHeadingMarkers", () => {
  it("removes heading markers but keeps their text", () => {
    expect(stripHeadingMarkers("## Channels\nseo, reddit")).toBe("Channels\nseo, reddit");
    expect(stripHeadingMarkers("# A\n## B\n### C")).toBe("A\nB\nC");
  });

  it("leaves a hash that is not a heading marker alone", () => {
    expect(stripHeadingMarkers("#1 priority is retention")).toBe("#1 priority is retention");
    expect(stripHeadingMarkers("#growth #seo")).toBe("#growth #seo");
    expect(stripHeadingMarkers("we charge $5 # not a heading")).toBe("we charge $5 # not a heading");
    expect(stripHeadingMarkers("####### seven hashes is not a heading")).toBe(
      "####### seven hashes is not a heading",
    );
  });
});

describe("clip", () => {
  it("flattens whitespace and caps length", () => {
    expect(clip("a\n\n  b")).toBe("a b");
    expect(clip("# Heading\nbody text")).toBe("body text");
    expect(clip("x".repeat(700)).length).toBe(600);
    expect(clip("x".repeat(700)).endsWith("…")).toBe(true);
  });
});

describe("signup alert v2 — answers, signal, plan, attribution, follow-up", () => {
  const base: TenantSummary = {
    tenant_id: "t1",
    slug: "gane",
    display_name: "Gane",
    path: "wizard",
    created_at: "2026-09-29T21:00:02.921815+00:00",
    owner_email: "someone@gmail.com",
    user_id: "u1",
    tier: "pilot",
    company_shape: "other",
    product_url: null,
    build_app_intent: "existing",
    company_scale_segment: null,
    goal: null,
    brain: [],
    typed_facts: { company_story: "All\n\nWho it is for: All\n\nFocus first: launch" },
    generated_story: null,
    growth: [],
    unanswered_growth: ["gtm_growth", "metrics_north_star"],
  };

  it("splits the wizard's labelled answers back into rows", () => {
    expect(parseWizardAnswers("We rent cars.\n\nWho it is for: travellers\n\nFocus first: bookings")).toEqual({
      sells: "We rent cars.",
      audience: "travellers",
      focus: "bookings",
    });
    expect(parseWizardAnswers("Just a paragraph about us.")).toBeNull();
    const { text } = renderNewTenantEmail(base);
    expect(text).toContain("## What they sell\nAll");
    expect(text).toContain("## Who it's for\nAll");
    expect(text).toContain("## Focus first\nlaunch");
    expect(text).not.toContain("All Who it is for");
  });

  it("drops the website and competitor paragraphs from the answers", () => {
    const a = parseWizardAnswers(
      "Payroll for dentists.\n\nWebsite: https://x.com\n\nFounder-confirmed competitors to track: Gusto\n\nFocus first: signups",
    );
    expect(a).toEqual({ sells: "Payroll for dentists.", audience: "", focus: "signups" });
  });

  it("flags a throwaway signup as low signal and names why", () => {
    const s = signalLine(base);
    expect(s.verdict).toBe("low");
    expect(s.line).toContain("personal email");
    expect(s.line).toContain("no website");
    expect(s.line).toContain('"All"');
    expect(renderNewTenantEmail(base).text.split("\n")[1]).toBe(s.line);
  });

  it("calls a work-email signup with a site and real answers real", () => {
    const s = signalLine({
      ...base,
      owner_email: "ceo@dentpay.com",
      product_url: "https://dentpay.com",
      typed_facts: { company_story: "Payroll for dental clinics.\n\nWho it is for: clinic owners" },
    });
    expect(s.verdict).toBe("real");
  });

  it("shows the billing plan, never the legacy tier column", () => {
    expect(planFromSubscription(null, new Date())).toBe("free");
    expect(planFromSubscription({ tier: "starter", status: "active" }, new Date())).toBe("starter");
    expect(planFromSubscription({ tier: "starter", status: "canceled" }, new Date())).toBe("free");
    expect(planFromSubscription({ tier: "pro", comp_expires_at: "2999-01-01T00:00:00Z" }, new Date())).toBe("pro (comp)");
    const { text } = renderNewTenantEmail({ ...base, plan: "free" });
    expect(text).toMatch(/Plan\s+free/);
    expect(text).not.toContain("pilot");
  });

  it("prints created time in Pacific", () => {
    expect(formatCreatedPt("2026-09-29T21:00:02Z")).toBe("Sep 29, 2026, 2:00 PM PT");
  });

  it("says unknown, not direct, when nothing was captured", () => {
    expect(renderNewTenantEmail(base).text).toContain("Came from      (unknown");
    const { text } = renderNewTenantEmail({
      ...base,
      attribution: { utm_source: "google", utm_medium: "cpc", click_id: "gclid", landing_path: "/pricing" },
    });
    expect(text).toContain("google / cpc · ad click (gclid) · landed /pricing");
  });

  it("reads plan + attribution, and arms the follow-up only after the send", async () => {
    const order: string[] = [];
    const d = deps({
      serviceClient: () =>
        fakeClient({
          tenants: [REAL_TENANT],
          tenant_subscriptions: [{ tier: "growth", status: "active", comp_expires_at: null }],
          tenant_app_setting: [
            { key: "signup_attribution", value: { referrer_host: "news.ycombinator.com", landing_path: "/" } },
          ],
        }),
    });
    d.sgSend.mockImplementation(async () => {
      order.push("send");
    });
    d.armFollowup.mockImplementation(async () => {
      order.push("arm");
    });
    await notifyNewTenant({ tenant_id: "t1", user_id: "u1", path: "wizard" }, d);
    const text = d.sgSend.mock.calls[0][3] as string;
    expect(text).toMatch(/Plan\s+growth/);
    expect(text).toContain("from news.ycombinator.com · landed /");
    expect(order).toEqual(["send", "arm"]);
    expect(d.armFollowup).toHaveBeenCalledWith("t1", "u1");
  });

  it("does not arm the follow-up when the alert was already sent", async () => {
    const d = deps({ getBoolSetting: vi.fn(async () => true) });
    await notifyNewTenant({ tenant_id: "t1", user_id: "u1", path: "wizard" }, d);
    expect(d.armFollowup).not.toHaveBeenCalled();
  });

  it("a failed arm does not fail the alert", async () => {
    const d = deps({
      serviceClient: () => fakeClient({ tenants: [REAL_TENANT] }),
      armFollowup: vi.fn(async () => {
        throw new Error("inngest down");
      }),
    });
    const out = await notifyNewTenant({ tenant_id: "t1", user_id: "u1", path: "wizard" }, d);
    expect(out).toEqual({ sent: true });
  });
});

describe("signup_alert_emails_enabled switch", () => {
  it("sends nothing, keeps the flag unflipped and arms no follow-up when muted", async () => {
    const d = deps({ signupAlertsEnabled: async () => false });
    const out = await notifyNewTenant({ tenant_id: "t1", user_id: "u1", path: "wizard" }, d);
    expect(out).toEqual({ sent: false, reason: "muted" });
    expect(d.sgSend).not.toHaveBeenCalled();
    expect(d.setTenantSetting).not.toHaveBeenCalled();
    expect(d.armFollowup).not.toHaveBeenCalled();
  });
});
