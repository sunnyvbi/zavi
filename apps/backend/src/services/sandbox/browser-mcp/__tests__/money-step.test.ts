import { describe, it, expect } from "vitest";
import {
  isMoneyStep,
  isAdHost,
  navLooksLikeMoney,
  evidenceFromResolve,
  moneyStepIdentity,
  targetFromResolve,
  identityDiff,
  canonicalOpArgs,
  type MoneyEvidence,
} from "../money-step";

function ev(over: Partial<MoneyEvidence>): MoneyEvidence {
  return {
    op: "click_ref",
    top_url: "https://app.example.com/",
    frame_url: null,
    role: "button",
    name: "",
    hints: "",
    is_submit: false,
    form_has_card_field: false,
    budget_fields: [],
    page_has_payment_frame: false,
    ...over,
  };
}

const FALSE_POSITIVES: [string, MoneyEvidence][] = [
  ["Save draft", ev({ name: "Save draft", top_url: "https://mail.google.com/mail/u/0/" })],
  ["Next", ev({ name: "Next", top_url: "https://app.hubspot.com/contacts/1/new" })],
  ["Continue on a non-checkout page", ev({ name: "Continue", top_url: "https://www.notion.so/onboarding" })],
  [
    "Publish in a Google Docs share dialog",
    ev({ name: "Publish", top_url: "https://docs.google.com/document/d/abc/edit" }),
  ],
  [
    "Subscribe to a newsletter, no card field, non-billing URL",
    ev({ name: "Subscribe", is_submit: true, top_url: "https://blog.example.com/posts/1" }),
  ],
  ["a link named Buy now only opens a page", ev({ name: "Buy now", role: "link", top_url: "https://shop.example.com/p/1" })],
  ["Payment methods (not the word pay)", ev({ name: "Payment methods", top_url: "https://app.example.com/settings" })],
  ["typing into a card number field", ev({ op: "type_ref", role: "textbox", name: "Card number", typed_text: "4242", form_has_card_field: true, top_url: "https://shop.example.com/checkout" })],
  ["typing a budget on a non-ad host", ev({ op: "type_ref", role: "textbox", name: "Budget", typed_text: "50", top_url: "https://sheets.google.com/x" })],
  ["Save on an ad host with no budget field", ev({ name: "Save", top_url: "https://ads.google.com/aw/settings" })],
  ["submit a login form on a page with Stripe", ev({ name: "Log in", is_submit: true, page_has_payment_frame: true })],
  ["Enter in a search box", ev({ op: "key", role: "searchbox", name: "Search", is_submit: true, top_url: "https://www.google.com/" })],
];

const TRUE_POSITIVES: [string, MoneyEvidence, string][] = [
  ["Meta Publish on Ads Manager", ev({ name: "Publish", top_url: "https://adsmanager.facebook.com/adsmanager/manage/campaigns" }), "money_label_in_context"],
  [
    "Google Ads Save after a budget change",
    ev({ name: "Save", top_url: "https://ads.google.com/aw/campaigns", budget_fields: [{ label: "Average daily budget", value: "$50.00" }] }),
    "ad_budget_save",
  ],
  ["Google Ads typing the budget", ev({ op: "type_ref", role: "textbox", name: "Average daily budget", typed_text: "50", top_url: "https://ads.google.com/aw/campaigns" }), "ad_budget_field"],
  ["Stripe checkout Pay", ev({ name: "Pay $49.00", top_url: "https://checkout.stripe.com/c/pay/cs_live_1" }), "money_label"],
  ["Shopify Complete order with card fields", ev({ name: "Complete order", is_submit: true, form_has_card_field: true, top_url: "https://shop.example.com/checkouts/cn/1" }), "money_label"],
  ["a plain Submit on a form with card fields", ev({ name: "Submit", is_submit: true, form_has_card_field: true, top_url: "https://pay.example.org/donate" }), "card_form_submit"],
  [
    "TikTok ads Submit with a budget",
    ev({ name: "Submit", is_submit: true, top_url: "https://ads.tiktok.com/i18n/perf/campaign", budget_fields: [{ label: "Budget", value: "100" }] }),
    "ad_budget_save",
  ],
  ["Subscribe with a card on the page", ev({ name: "Subscribe", is_submit: true, page_has_payment_frame: true, top_url: "https://app.example.com/plans" }), "money_label_in_context"],
  ["Enter in a card form", ev({ op: "key", role: "textbox", name: "CVC", is_submit: true, form_has_card_field: true }), "card_form_submit"],
  ["LinkedIn Launch campaign", ev({ name: "Launch campaign", top_url: "https://www.linkedin.com/campaignmanager/accounts/1" }), "money_label_in_context"],
];

describe("isMoneyStep: false positives never pause", () => {
  it("the false-positive set is at least as long as the true-positive set", () => {
    expect(FALSE_POSITIVES.length).toBeGreaterThanOrEqual(TRUE_POSITIVES.length);
  });
  it.each(FALSE_POSITIVES)("%s", (_n, e) => {
    expect(isMoneyStep(e).money).toBe(false);
  });
});

describe("isMoneyStep: clear money pauses", () => {
  it("covers at least 3 ad platforms and 1 non-ad checkout", () => {
    const hosts = new Set(TRUE_POSITIVES.map(([, e]) => new URL(e.top_url!).hostname));
    expect([...hosts].filter((h) => isAdHost(`https://${h}/adsmanager`) || isAdHost(`https://${h}/campaignmanager`)).length).toBeGreaterThanOrEqual(3);
    expect(hosts.has("checkout.stripe.com")).toBe(true);
  });
  it.each(TRUE_POSITIVES)("%s", (_n, e, reason) => {
    const v = isMoneyStep(e);
    expect(v.money).toBe(true);
    expect(v.reason).toBe(reason);
  });
  it("carries host, label and value for the card", () => {
    expect(isMoneyStep(TRUE_POSITIVES[2][1])).toMatchObject({ host: "ads.google.com", label: "Average daily budget", value: "50" });
    expect(isMoneyStep(TRUE_POSITIVES[1][1]).value).toBe("Average daily budget: $50.00");
  });
  it("matches words, case-insensitive, not substrings", () => {
    expect(isMoneyStep(ev({ name: "PLACE   ORDER" })).money).toBe(true);
    expect(isMoneyStep(ev({ name: "Buyer protection" })).money).toBe(false);
    expect(isMoneyStep(ev({ name: "Repay history" })).money).toBe(false);
  });
});

describe("the unsure case goes ahead (D5) and is flagged for telemetry", () => {
  it("bare Confirm on a billing URL: not money, unsure", () => {
    const v = isMoneyStep(ev({ name: "Confirm", top_url: "https://app.example.com/billing/plan" }));
    expect(v).toMatchObject({ money: false, unsure: true });
  });
  it("bare Continue on a checkout URL: not money, unsure", () => {
    expect(isMoneyStep(ev({ name: "Continue →", top_url: "https://shop.example.com/checkout/shipping" })).unsure).toBe(true);
  });
  it("Continue elsewhere is not even unsure", () => {
    expect(isMoneyStep(ev({ name: "Continue", top_url: "https://app.example.com/setup" })).unsure).toBeUndefined();
  });
});

describe("navigation", () => {
  it("a pay / checkout / purchase / subscribe action URL is money", () => {
    for (const u of ["https://app.example.com/pay/inv_1", "https://shop.example.com/checkout", "https://x.example.com/billing/subscribe-pro"]) {
      expect(isMoneyStep({ ...ev({ op: "nav" }), nav_url: u }).money).toBe(true);
    }
  });
  it("delete / unsubscribe / confirm links are NOT money (D14: only money pauses)", () => {
    for (const u of ["https://app.example.com/delete/1", "https://news.example.com/unsubscribe?u=1", "https://app.example.com/confirm-email"]) {
      expect(navLooksLikeMoney(u)).toBe(false);
    }
  });
  it("an ordinary page is not money", () => {
    expect(isMoneyStep({ ...ev({ op: "nav" }), nav_url: "https://ads.google.com/aw/overview" }).money).toBe(false);
  });
});

describe("ad hosts", () => {
  it.each([
    ["https://adsmanager.facebook.com/adsmanager", true],
    ["https://business.facebook.com/latest/ad_center", true],
    ["https://www.facebook.com/adsmanager/manage", true],
    ["https://www.facebook.com/somepage", false],
    ["https://ads.google.com/aw/overview", true],
    ["https://ads.tiktok.com/i18n/perf", true],
    ["https://www.linkedin.com/campaignmanager/accounts", true],
    ["https://www.linkedin.com/feed", false],
    ["https://ads.x.com/", true],
    ["https://ads.reddit.com/", true],
    ["https://ads.snapchat.com/", true],
    ["https://ads.pinterest.com/", true],
    ["https://ads.google.com.evil.example/", false],
  ])("%s → %s", (u, want) => {
    expect(isAdHost(u)).toBe(want);
  });
});

describe("links are judged by where they go", () => {
  it("a Pay-now link to a pay URL pauses", () => {
    expect(isMoneyStep(ev({ role: "link", name: "Pay now", href: "https://billing.example.com/invoices/1/pay" })).money).toBe(true);
  });
  it("a generic Buy menu link to a shop page does not pause", () => {
    expect(isMoneyStep(ev({ role: "link", name: "Buy", href: "https://www.example.com/shop" })).money).toBe(false);
  });
  it("a hosted payment link (opaque path) pauses", () => {
    expect(isMoneyStep(ev({ role: "link", name: "Checkout", href: "https://buy.stripe.com/aEU3cd9x" })).money).toBe(true);
  });
  it("a Pay now link pauses even with an unknown destination", () => {
    expect(isMoneyStep(ev({ role: "link", name: "Pay now", href: "https://app.example.com/i/7x" })).money).toBe(true);
  });
  it("a relative href is resolved against the frame URL", () => {
    const e = evidenceFromResolve({ op: "click_ref" }, { role: "link", name: "Pay", href: "/checkout/pay?x=1", frame_url: "https://shop.example.com/cart" });
    expect(e.href).toBe("https://shop.example.com/checkout/pay?x=1");
  });
});

describe("resolve parsing + identity", () => {
  const raw = {
    top_url: "https://ads.google.com/aw/campaigns",
    frame_url: "https://ads.google.com/aw/campaigns",
    role: "button",
    name: "Save",
    hints: "save-btn",
    is_submit: true,
    ref: { frame_session: null, backend_node_id: 7 },
    form: { has_card_field: false, budget_fields: [{ label: "Budget", value: "$50" }] },
    page_has_payment_frame: false,
  };
  it("missing fields read as no signal", () => {
    const e = evidenceFromResolve({ op: "click_ref" }, { top_url: "https://x.example/" });
    expect(e).toMatchObject({ name: "", is_submit: false, form_has_card_field: false, budget_fields: [] });
    expect(isMoneyStep(e).money).toBe(false);
  });
  it("identity changes when anything that matters changes", () => {
    const op = { op: "click_ref", ref: { frame_session: null, backend_node_id: 7 } };
    const id = (r: unknown) => {
      const e = evidenceFromResolve({ op: "click_ref" }, r);
      return moneyStepIdentity(op, e, isMoneyStep(e), targetFromResolve(r));
    };
    const base = id(raw);
    expect(identityDiff(base, id(structuredClone(raw)))).toEqual([]);
    expect(identityDiff(base, id({ ...raw, name: "Save and publish" }))).toContain("label");
    expect(identityDiff(base, id({ ...raw, form: { ...raw.form, budget_fields: [{ label: "Budget", value: "$5000" }] } }))).toEqual(
      expect.arrayContaining(["budget_fields", "value"]),
    );
    expect(identityDiff(base, id({ ...raw, ref: { frame_session: "F1", backend_node_id: 7 } }))).toContain("frame_session");
    expect(identityDiff(base, id({ ...raw, role: "link" }))).toContain("role");
    expect(identityDiff(base, id({ ...raw, frame_url: "https://evil.example/" }))).toContain("frame_url");
    expect(identityDiff(base, id({ ...raw, amounts: ["$20.00"] }))).toContain("amounts");
    expect(identityDiff(base, id({ ...raw, href: "https://x.example/pay" }))).toContain("href");
  });
  it("canonical op args ignore key order", () => {
    expect(canonicalOpArgs({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalOpArgs({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe("H1 ops", () => {
  it("select_option on an ad host's budget field is money (value = the option); elsewhere not", () => {
    const v = isMoneyStep(ev({ op: "select_option", role: "combobox", name: "Bid strategy", top_url: "https://ads.google.com/aw/", typed_text: "Target CPA" }));
    expect(v).toMatchObject({ money: true, reason: "ad_budget_field", value: "Target CPA" });
    expect(isMoneyStep(ev({ op: "select_option", role: "combobox", name: "Country", top_url: "https://ads.google.com/aw/" })).money).toBe(false);
    expect(isMoneyStep(ev({ op: "select_option", role: "combobox", name: "Budget", top_url: "https://app.example.com/" })).money).toBe(false);
  });

  it("set_checked follows the click rules only", () => {
    expect(isMoneyStep(ev({ op: "set_checked", role: "checkbox", name: "I agree to the terms", form_has_card_field: true, top_url: "https://shop.example.com/checkout" })).money).toBe(false);
    expect(isMoneyStep(ev({ op: "set_checked", role: "checkbox", name: "Boost this post", top_url: "https://app.example.com/" })).money).toBe(true);
  });

  it("evidence carries the chosen option as the typed text", () => {
    expect(evidenceFromResolve({ op: "select_option", text: "Lifetime" }, {}).typed_text).toBe("Lifetime");
  });
});
