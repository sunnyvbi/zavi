import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const { createMock, researchIdea, getBoolSetting } = vi.hoisted(() => ({
  createMock: vi.fn(),
  researchIdea: vi.fn(),
  getBoolSetting: vi.fn(),
}));

vi.mock("@/services/anthropic", () => ({
  getAnthropic: () => ({ messages: { create: createMock } }),
  hasAnthropicAuth: () => true,
  DEFAULT_FAST_MODEL: "claude-sonnet-4-6",
  cachedSystemBlock: (text: string) => ({ type: "text", text }),
}));
vi.mock("@/services/auth/jwt", () => ({ verifyBearer: vi.fn(async () => null) }));
vi.mock("@/services/onboarding/enrichment/sanitize", () => ({
  sanitizeFetchedContent: (s: string) => s,
  xmlEscapeContent: (s: string) => s,
}));
vi.mock("@/services/onboarding/brainstorm-research", () => ({ researchIdea }));
vi.mock("@/services/settings", () => ({ getBoolSetting }));

import { onboardingBrainstorm, redirectsAwayFromZavi, __test } from "../brainstorm";

const BAKERY =
  "I run a small bakery in Austin and just want a simple website with my menu, hours, and a way to order cakes.";

const TICKET_OPENING = {
  message:
    "A website with menu + hours is table stakes now—Squarespace or Wix solve that in an afternoon for $15/mo. What would make yours different?",
  options: [
    "Custom cake ordering flow",
    "Just get you live fast on existing platform",
    "Local delivery wedge",
  ],
  recommended: "Custom cake ordering flow",
};

const TICKET_FOLLOW_UP = {
  message:
    "Then this isn't a Zavi problem—Squarespace already does that, and it's cheaper and faster. You're looking for a quick website builder, which is the wrong tool.",
  options: null,
  recommended: null,
};

const GOOD = {
  message:
    "A cake order form is the part that earns money, so it should lead the site. Do customers pick up in store, or do you deliver?",
  options: ["Pickup only", "Delivery in Austin", "Both"],
  recommended: "Pickup only",
};

function reply(obj: unknown) {
  return { content: [{ type: "text", text: `<reply>${JSON.stringify(obj)}</reply>` }] };
}

function mockRes() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { status, json } as unknown as Response, status, json };
}

function req(body: object): Request {
  return { body, headers: {}, ip: "198.51.100.9", socket: { remoteAddress: "198.51.100.9" } } as unknown as Request;
}

function systemOf(call: number): string {
  return createMock.mock.calls[call][0].system[0].text as string;
}

async function chat(history: { role: "agent" | "user"; text: string }[] = []) {
  const r = mockRes();
  await onboardingBrainstorm(req({ seedIdea: BAKERY, history, mode: "chat" }), r.res);
  return r;
}

describe("DEL-1323 B8: brainstorm never sends a website seeker to another tool", () => {
  beforeEach(() => {
    createMock.mockReset();
    researchIdea.mockReset();
    getBoolSetting.mockReset();
    getBoolSetting.mockResolvedValue(true);
    __test.resetLimits();
  });

  it("tells the model Zavi builds it and asks 2-3 clarifying questions", async () => {
    createMock.mockResolvedValueOnce(reply(GOOD));
    await chat();
    const sys = systemOf(0);
    expect(sys).toContain("ZAVI BUILDS IT");
    expect(sys).toMatch(/Never tell the visitor to use another product or platform instead/);
    expect(sys).toMatch(/never call Zavi the wrong tool/);
    expect(sys).toMatch(/ask 2-3 clarifying questions, one per turn/);
    expect(sys).toMatch(/tap "Use this idea"/);
    expect(getBoolSetting).toHaveBeenCalledWith("brainstorm_always_build");
  });

  it("retries the ticket's Squarespace/Wix opening and serves the build reply", async () => {
    createMock.mockResolvedValueOnce(reply(TICKET_OPENING)).mockResolvedValueOnce(reply(GOOD));
    const { status, json } = await chat();
    expect(status).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(2);
    const body = json.mock.calls[0][0];
    expect(body.message).toBe(GOOD.message);
    expect(body.options).toEqual(GOOD.options);
  });

  it("never shows the 'wrong tool' follow-up, even when every attempt says it", async () => {
    createMock.mockResolvedValue(reply(TICKET_FOLLOW_UP));
    const { status, json } = await chat([
      { role: "agent", text: TICKET_OPENING.message },
      { role: "user", text: "Just get you live fast on existing platform" },
    ]);
    expect(status).not.toHaveBeenCalled();
    const body = json.mock.calls[0][0];
    expect(body.ok).toBe(true);
    expect(body.done).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/squarespace|wix|wrong tool|existing platform|zavi problem/i);
    expect(body.message).toMatch(/Zavi can build this/);
    expect(body.options).toContain(body.recommended);
  });

  it("rejects a reply whose only redirect is an 'existing platform' option", async () => {
    createMock
      .mockResolvedValueOnce(reply({ ...GOOD, options: ["Custom site", "Just get you live fast on existing platform"], recommended: "Custom site" }))
      .mockResolvedValueOnce(reply(GOOD));
    const { json } = await chat();
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(json.mock.calls[0][0].options).toEqual(GOOD.options);
  });

  it("keeps a reply that only names a builder as context", async () => {
    const context = { ...GOOD, message: "Most bakery sites on Wix stop at a menu page. Yours can take the cake order itself. Pickup or delivery?" };
    createMock.mockResolvedValueOnce(reply(context));
    const { json } = await chat();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0][0].message).toBe(context.message);
  });

  it("serves a Shopify-app reply that cites a competitor price on the first attempt", async () => {
    const shopifyApp = {
      message:
        "Shopify merchants using restock apps today pay about $20/month, and Mindbody charges $129/month for studio scheduling. Which merchants lose the most to stockouts?",
      options: ["Apparel stores", "Food and drink", "Beauty brands"],
      recommended: "Apparel stores",
    };
    createMock.mockResolvedValue(reply(shopifyApp));
    const { json } = await chat([{ role: "user", text: "A Shopify app that emails back-in-stock alerts" }]);
    expect(createMock).toHaveBeenCalledTimes(1);
    const body = json.mock.calls[0][0];
    expect(body.message).toBe(shopifyApp.message);
    expect(body.options).toEqual(shopifyApp.options);
  });

  it("keeps a research opening line that only states a competitor price", async () => {
    const opening = "Mindbody charges $129/month and Vagaro handles bookings for salons, so a flat-price studio site has room.";
    researchIdea.mockResolvedValue({
      competitors: [{ name: "Mindbody", angle: "scheduling" }],
      market: "",
      pricing: "",
      gap: "",
      wedge: "",
      v1: "",
      opening_message: opening,
      sources: [],
      evidence_sources: [],
      grounded: false,
    });
    const r = mockRes();
    await onboardingBrainstorm(req({ seedIdea: BAKERY, history: [], mode: "research" }), r.res);
    expect(r.json.mock.calls[0][0].message).toBe(opening);
  });

  it("replaces a research opening line that points at Squarespace", async () => {
    researchIdea.mockResolvedValue({
      competitors: [{ name: "Squarespace", angle: "templates" }],
      market: "",
      pricing: "",
      gap: "",
      wedge: "",
      v1: "",
      opening_message: "Honestly, Squarespace already does this for $16/mo, so try that first.",
      sources: [],
      evidence_sources: [],
      grounded: false,
    });
    const { json } = mockRes();
    const r = mockRes();
    await onboardingBrainstorm(req({ seedIdea: BAKERY, history: [], mode: "research" }), r.res);
    expect(json).not.toHaveBeenCalled();
    expect(researchIdea).toHaveBeenCalledWith(BAKERY, { alwaysBuild: true });
    const body = r.json.mock.calls[0][0];
    expect(body.message).not.toMatch(/squarespace/i);
    expect(body.message).toMatch(/Zavi can build this/);
  });

  it("with the key off, sends the old prompt and serves the reply unchecked", async () => {
    getBoolSetting.mockResolvedValue(false);
    createMock.mockResolvedValueOnce(reply(TICKET_OPENING));
    const { json } = await chat();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(systemOf(0)).not.toContain("ZAVI BUILDS IT");
    expect(json.mock.calls[0][0].message).toBe(TICKET_OPENING.message);
  });

  it("with the key off, research gets no always-build option", async () => {
    getBoolSetting.mockResolvedValue(false);
    researchIdea.mockResolvedValue({
      competitors: [],
      market: "",
      pricing: "",
      gap: "",
      wedge: "",
      v1: "",
      opening_message: "Squarespace solves that in an afternoon.",
      sources: [],
      evidence_sources: [],
      grounded: false,
    });
    const r = mockRes();
    await onboardingBrainstorm(req({ seedIdea: BAKERY, history: [], mode: "research" }), r.res);
    expect(researchIdea).toHaveBeenCalledWith(BAKERY, { alwaysBuild: false });
    expect(r.json.mock.calls[0][0].message).toBe("Squarespace solves that in an afternoon.");
  });
});

describe("redirectsAwayFromZavi", () => {
  it.each([
    TICKET_OPENING.message,
    TICKET_FOLLOW_UP.message,
    "Squarespace or Mindbody handle this fine for $20/month.",
    "Squarespace or Wix would get your yoga studio online today for less.",
    "You could use WordPress for this.",
    "Zavi isn't the right tool for a brochure site.",
    "Honestly, you could use Wix for the menu page.",
    "For something this small, just use Squarespace.",
    "Try Shopify instead.",
    "Sign up for Wix and you are done.",
    "Squarespace would get you online this afternoon.",
    "The quickest path is to use an existing platform.",
    "You'd be better off with a Squarespace template; it takes an hour.",
    "I'd go with Carrd for a one-page site.",
    "Consider using Squarespace for the menu.",
    "I recommend Vagaro for the bookings.",
    "Mindbody already covers all of this.",
    "Wix and Squarespace are cheaper than building one.",
    "Maybe get Squarespace instead.",
    "It's a small site, so just use Squarespace.",
    "You're better off using Wix for this.",
  ])("flags %s", (text) => {
    expect(redirectsAwayFromZavi(text)).toBe(true);
  });

  it.each([
    GOOD.message,
    "Most bakery sites on Wix stop at a menu page.",
    "Unlike a Squarespace template, the order form here writes to your own database.",
    "Mindbody charges $129/month, which is steep for a two-room studio.",
    "Vagaro handles bookings for salons, but its per-seat price scares off solo stylists.",
    "Build a Shopify app for merchants who want back-in-stock alerts.",
    "Shopify merchants using our tool can restock without spreadsheets.",
    "Unlike Wix, your booking page can hold a deposit before the slot is confirmed.",
    "Most yoga studios on Mindbody pay around $139/month, so a $29/mo flat price is a real wedge.",
    "Studios that use Acuity still chase no-shows by text.",
    "You could sell it through the Shopify App Store once ten merchants use it.",
    "You should start with Shopify merchants who sell apparel.",
    "Build an app that plugs into the Shopify API and flags stale inventory.",
    "Instead of a Wix template, the site takes the cake order itself.",
    "Since you're using Wix now, moving the menu into a Zavi site takes an afternoon.",
    "If you're using Squarespace today, we can carry your menu over.",
    "Most salons just use Vagaro, so a booking page that also sells gift cards stands out.",
    "Most bakeries, using Wix, stop at a menu page.",
  ])("does not flag %s", (text) => {
    expect(redirectsAwayFromZavi(text)).toBe(false);
  });
});

function landscape(over: Record<string, unknown> = {}) {
  return {
    competitors: [{ name: "Vagaro", angle: "salon bookings" }],
    market: "Most salons just use Vagaro, and few sell gift cards online.",
    pricing: "",
    gap: "Solo stylists pay per-seat fees for tools built for big salons.",
    wedge: "Just use Squarespace and add a booking widget.",
    v1: "Honestly, you could use Wix for the first version.",
    opening_message: "Solo stylists overpay for booking. Who books with you today?",
    sources: [],
    evidence_sources: [],
    grounded: false,
    ...over,
  };
}

describe("DEL-1323 B8 follow-ups: false positives, retry note, research fields", () => {
  beforeEach(() => {
    createMock.mockReset();
    researchIdea.mockReset();
    getBoolSetting.mockReset();
    getBoolSetting.mockResolvedValue(true);
    __test.resetLimits();
  });

  it("serves a reply about a visitor moving off Wix on the first attempt", async () => {
    const migrating = {
      message:
        "Since you're using Wix now, moving the menu into a Zavi site takes an afternoon. Most salons just use Vagaro for bookings, so which page earns you the most?",
      options: ["Cake orders", "Menu", "Contact"],
      recommended: "Cake orders",
    };
    createMock.mockResolvedValue(reply(migrating));
    const { json } = await chat([{ role: "user", text: "I'm on Wix today and want off it" }]);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0][0].message).toBe(migrating.message);
  });

  it("retries a redirect with a corrective note, not the identical prompt", async () => {
    createMock.mockResolvedValueOnce(reply(TICKET_OPENING)).mockResolvedValueOnce(reply(GOOD));
    await chat();
    expect(createMock).toHaveBeenCalledTimes(2);
    const first = createMock.mock.calls[0][0].messages[0].content as string;
    const second = createMock.mock.calls[1][0].messages[0].content as string;
    expect(first).not.toMatch(/Your last reply/);
    expect(second).not.toBe(first);
    expect(second.startsWith(first)).toBe(true);
    expect(second).toMatch(/Your last reply told them to use another product or platform/);
    expect(systemOf(1)).toBe(systemOf(0));
  });

  it("does not add the redirect note when the first reply was only malformed", async () => {
    createMock
      .mockResolvedValueOnce({ content: [{ type: "text", text: "" }] })
      .mockResolvedValueOnce(reply(GOOD));
    await chat();
    const first = createMock.mock.calls[0][0].messages[0].content as string;
    const second = createMock.mock.calls[1][0].messages[0].content as string;
    expect(second.startsWith(first)).toBe(true);
    expect(second).not.toMatch(/another product or platform|wrong tool/);
  });

  it("drops research fields that send the visitor elsewhere and keeps the rest", async () => {
    researchIdea.mockResolvedValue(landscape());
    const r = mockRes();
    await onboardingBrainstorm(req({ seedIdea: BAKERY, history: [], mode: "research" }), r.res);
    const shown = r.json.mock.calls[0][0].landscape;
    expect(shown.wedge).toBe("");
    expect(shown.v1).toBe("");
    expect(shown.market).toBe(landscape().market);
    expect(shown.gap).toBe(landscape().gap);
    expect(JSON.stringify(shown)).not.toMatch(/squarespace|wix/i);
  });

  it("cleans a landscape cached while the key was off when the key is on", async () => {
    researchIdea.mockResolvedValue(landscape());
    getBoolSetting.mockResolvedValue(false);
    const off = mockRes();
    await onboardingBrainstorm(req({ seedIdea: BAKERY, history: [], mode: "research" }), off.res);
    expect(off.json.mock.calls[0][0].landscape.wedge).toBe(landscape().wedge);
    expect(off.json.mock.calls[0][0].landscape.v1).toBe(landscape().v1);

    getBoolSetting.mockResolvedValue(true);
    const on = mockRes();
    await onboardingBrainstorm(req({ seedIdea: BAKERY, history: [], mode: "research" }), on.res);
    expect(researchIdea).toHaveBeenCalledTimes(1);
    const shown = on.json.mock.calls[0][0].landscape;
    expect(shown.wedge).toBe("");
    expect(shown.v1).toBe("");
    expect(shown.gap).toBe(landscape().gap);
  });
});

describe("DEL-1323 B8 review follow-ups: narrower redirect check, wider platform list, sticky rejection", () => {
  beforeEach(() => {
    createMock.mockReset();
    researchIdea.mockReset();
    getBoolSetting.mockReset();
    getBoolSetting.mockResolvedValue(true);
    __test.resetLimits();
  });

  it.each([
    ["Spreadsheets are the wrong tool for tracking orders, so let's build a real order page.", false],
    ["No existing platform serves home bakers well, which is your wedge.", false],
    ["Should the site connect to an existing platform like your POS?", false],
    ["You'd switch to your own site from Booksy, cutting fees.", false],
    ["Great, try Vagaro-style booking?", false],
    ["Try Vagaro-style booking", false],
    ["Use a square logo in the header.", false],
    ["Zavi is the wrong tool for this.", true],
    ["That is the wrong tool for you.", true],
    ["Just use an existing platform.", true],
    ["Stick with an existing platform for now.", true],
    ["You can just use Wix for this.", true],
    ["Honestly, Squarespace is your best bet.", true],
    ["Squarespace is the way to go.", true],
    ["A Wix site would do the job.", true],
    ["You could build this in an afternoon on Squarespace.", true],
    ["Have you looked at Shopify?", true],
    ["Go for Squarespace.", true],
    ["I'd point you to Wix.", true],
    ["You don't need a custom build; Squarespace works fine.", true],
    ["Calendly handles all of this already.", true],
    ["Just sell on Etsy.", true],
    ["Just use Square.", true],
    ["Try Framer instead.", true],
    ["You could use Linktree for this.", true],
    ["Go with Webflow.", true],
  ])("%s -> caught=%s", (text, caught) => {
    expect(redirectsAwayFromZavi(text)).toBe(caught);
  });

  it("serves a Vagaro-style option on the first attempt", async () => {
    const styled = { ...GOOD, options: ["Try Vagaro-style booking", "Pickup only", "Both"], recommended: "Pickup only" };
    createMock.mockResolvedValue(reply(styled));
    const { json } = await chat();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0][0].options).toEqual(styled.options);
  });

  it("serves the canned build reply when the retry after a redirect hits an upstream error", async () => {
    createMock
      .mockResolvedValueOnce(reply(TICKET_OPENING))
      .mockRejectedValueOnce(Object.assign(new Error("overloaded"), { status: 529 }));
    const { status, json } = await chat();
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(status).not.toHaveBeenCalled();
    const body = json.mock.calls[0][0];
    expect(body.ok).toBe(true);
    expect(body.message).toMatch(/Zavi can build this/);
    expect(JSON.stringify(body)).not.toMatch(/squarespace|wix/i);
  });

  it("serves the canned build reply when the retry after a redirect is unparseable", async () => {
    createMock
      .mockResolvedValueOnce(reply(TICKET_OPENING))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "" }] });
    const { status, json } = await chat();
    expect(status).not.toHaveBeenCalled();
    expect(json.mock.calls[0][0].message).toMatch(/Zavi can build this/);
  });

  it("serves the canned build reply when the retry after a redirect times out", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const c = new AbortController();
      setTimeout(() => c.abort(new Error("timed out")), 20);
      return c.signal;
    });
    createMock
      .mockResolvedValueOnce(reply(TICKET_OPENING))
      .mockImplementationOnce(() => new Promise(() => {}));
    const { status, json } = await chat();
    timeout.mockRestore();
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(status).not.toHaveBeenCalled();
    expect(json.mock.calls[0][0].message).toMatch(/Zavi can build this/);
  });

  it("still fails with 502 when the only failure was an upstream error", async () => {
    createMock.mockRejectedValueOnce(Object.assign(new Error("overloaded"), { status: 529 }));
    const { status } = await chat();
    expect(status).toHaveBeenCalledWith(502);
  });
});
