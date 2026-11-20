import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const { createMock, getBoolSetting } = vi.hoisted(() => ({
  createMock: vi.fn(),
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
vi.mock("@/services/onboarding/brainstorm-research", () => ({ researchIdea: vi.fn() }));
vi.mock("@/services/settings", () => ({ getBoolSetting }));

import { onboardingBrainstorm, briefIsNotABuildPrompt, __test } from "../brainstorm";

const BAKERY =
  "I run a small bakery in Austin and just want a simple website with my menu, hours, and a way to order cakes.";

const TICKET_MEMO =
  "This conversation has not reached a viable build brief. The visitor is seeking a basic website (menu, hours, cake ordering) for a small Austin bakery. Recommend the visitor either identify a concrete constraint beyond 'having a website' or use an existing platform.";

const GOOD_BRIEF =
  "Build a website for my Austin bakery: a menu page, opening hours, and a cake order form where customers pick a size, flavour and pickup date. Orders land in an admin list I can check each morning.";

const HISTORY = [
  {
    role: "agent" as const,
    text: "A cake order form is the part that earns money. Pickup or delivery?",
  },
  { role: "user" as const, text: "Pickup only, from the shop" },
  { role: "agent" as const, text: "How far ahead do people order?" },
  { role: "user" as const, text: "At least two days ahead" },
];

function reply(obj: unknown) {
  return { content: [{ type: "text", text: `<reply>${JSON.stringify(obj)}</reply>` }] };
}

function mockRes() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { status, json } as unknown as Response, status, json };
}

function req(body: object): Request {
  return { body, headers: {}, ip: "198.51.100.10", socket: { remoteAddress: "198.51.100.10" } } as unknown as Request;
}

function systemOf(call: number): string {
  return createMock.mock.calls[call][0].system[0].text as string;
}

async function summarize(seedIdea = BAKERY, history = HISTORY) {
  const r = mockRes();
  await onboardingBrainstorm(req({ seedIdea, history, mode: "summarize" }), r.res);
  return r;
}

function briefKeyOff() {
  getBoolSetting.mockImplementation(async (key: string) => key !== "brainstorm_build_brief");
}

describe("DEL-1323 B9: 'Use this idea' never pastes a refusal memo into the build box", () => {
  beforeEach(() => {
    createMock.mockReset();
    getBoolSetting.mockReset();
    getBoolSetting.mockResolvedValue(true);
    __test.resetLimits();
  });

  it("asks for a first-person build request and reads the key", async () => {
    createMock.mockResolvedValueOnce(reply({ brief: GOOD_BRIEF }));
    await summarize();
    const sys = systemOf(0);
    expect(sys).toContain("WRITE IT AS THEIR BUILD REQUEST");
    expect(sys).toMatch(/in their voice, first person, starting with what to build/);
    expect(sys).toMatch(/never say a brief is not ready/);
    expect(sys).toMatch(/never recommend another product or platform/);
    expect(getBoolSetting).toHaveBeenCalledWith("brainstorm_build_brief");
  });

  it("serves a good build brief on the first try", async () => {
    createMock.mockResolvedValueOnce(reply({ brief: GOOD_BRIEF }));
    const { status, json } = await summarize();
    expect(status).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0][0]).toEqual({ ok: true, mode: "summarize", brief: GOOD_BRIEF });
  });

  it("retries the ticket's memo and serves the build brief", async () => {
    createMock
      .mockResolvedValueOnce(reply({ brief: TICKET_MEMO }))
      .mockResolvedValueOnce(reply({ brief: GOOD_BRIEF }));
    const { json } = await summarize();
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(json.mock.calls[0][0].brief).toBe(GOOD_BRIEF);
  });

  it("when every attempt is the memo, the idea box gets the visitor's own words as a build request", async () => {
    createMock.mockResolvedValue(reply({ brief: TICKET_MEMO }));
    const { status, json } = await summarize();
    expect(status).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(2);
    const body = json.mock.calls[0][0];
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("summarize");
    expect(body.brief).toBe(
      `Build this for me: ${BAKERY} Pickup only, from the shop. At least two days ahead.`,
    );
    expect(body.brief).not.toMatch(/visitor|conversation|viable|existing platform|recommend/i);
    expect(briefIsNotABuildPrompt(body.brief)).toBe(false);
  });

  it("rejects a brief that sends them to Squarespace", async () => {
    createMock
      .mockResolvedValueOnce(
        reply({ brief: "A bakery site with menu and hours. Squarespace handles this for $16/mo, so use that." }),
      )
      .mockResolvedValueOnce(reply({ brief: GOOD_BRIEF }));
    const { json } = await summarize();
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(json.mock.calls[0][0].brief).toBe(GOOD_BRIEF);
  });

  it("with nothing the visitor said to fall back on, fails instead of pasting the memo", async () => {
    createMock.mockResolvedValue(reply({ brief: TICKET_MEMO }));
    const { status, json } = await summarize("", []);
    expect(status).toHaveBeenCalledWith(502);
    expect(JSON.stringify(json.mock.calls)).not.toContain("viable build brief");
  });

  it("with the key off, sends the old prompt and serves the memo unchecked", async () => {
    briefKeyOff();
    createMock.mockResolvedValueOnce(reply({ brief: TICKET_MEMO }));
    const { json } = await summarize();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(systemOf(0)).not.toContain("WRITE IT AS THEIR BUILD REQUEST");
    expect(json.mock.calls[0][0].brief).toBe(TICKET_MEMO);
  });

  it("a failed settings read keeps the fix on", async () => {
    getBoolSetting.mockRejectedValue(new Error("db down"));
    createMock.mockResolvedValue(reply({ brief: TICKET_MEMO }));
    const { json } = await summarize();
    expect(json.mock.calls[0][0].brief).toMatch(/^Build this for me: /);
  });

  it("chat turns never read the brief key", async () => {
    createMock.mockResolvedValueOnce(
      reply({ message: "Pickup or delivery?", options: ["Pickup", "Delivery"], recommended: "Pickup" }),
    );
    const r = mockRes();
    await onboardingBrainstorm(req({ seedIdea: BAKERY, history: [], mode: "chat" }), r.res);
    expect(getBoolSetting).not.toHaveBeenCalledWith("brainstorm_build_brief");
  });
});

describe("briefIsNotABuildPrompt", () => {
  it.each([
    TICKET_MEMO,
    "The visitor wants a bakery website with a menu.",
    "Not yet ready to build: the idea needs a clearer wedge.",
    "We recommend the user start with a template.",
    "A menu site. Wix gets you online for $14/month instead.",
    "The user wants a menu page and an order form.",
    "A bakery site. This conversation stayed vague about pickup.",
    "Build a bakery site; the visitor is seeking a cheap option.",
  ])("flags %s", (brief) => {
    expect(briefIsNotABuildPrompt(brief)).toBe(true);
  });

  it.each([
    GOOD_BRIEF,
    "Build a booking site for my yoga studio where the user picks a class and pays at the door.",
    "Build me a site for my cake shop. Orders are not ready until the next afternoon, so show the pickup date.",
    "Build a portfolio site that looks nothing like a Wix template.",
    "Build a Shopify app for merchants using Shopify Payments that emails back-in-stock alerts; competitors charge $20/month.",
    "Build a booking site for my studio. Mindbody charges $129/month, so mine should be a flat $29/mo.",
    "Build a website for my wedding venue with a gallery and a page where the visitor can book a tour.",
    "Build a guestbook page where the visitor leaves a note, and show the latest ten in this conversation-style feed.",
  ])("keeps %s", (brief) => {
    expect(briefIsNotABuildPrompt(brief)).toBe(false);
  });
});

describe("DEL-1323 B9 follow-ups: memo check, retry note, clean fallback", () => {
  beforeEach(() => {
    createMock.mockReset();
    getBoolSetting.mockReset();
    getBoolSetting.mockResolvedValue(true);
    __test.resetLimits();
  });

  it("serves a build brief that mentions what the visitor can do on the site", async () => {
    const venue = "Build a website for my wedding venue with a gallery and a page where the visitor can book a tour.";
    createMock.mockResolvedValue(reply({ brief: venue }));
    const { json } = await summarize();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0][0].brief).toBe(venue);
  });

  it("retries a memo with a corrective note appended to the same prompt", async () => {
    createMock
      .mockResolvedValueOnce(reply({ brief: TICKET_MEMO }))
      .mockResolvedValueOnce(reply({ brief: GOOD_BRIEF }));
    await summarize();
    const first = createMock.mock.calls[0][0].messages[0].content as string;
    const second = createMock.mock.calls[1][0].messages[0].content as string;
    expect(first).not.toMatch(/Your last brief/);
    expect(second.startsWith(first)).toBe(true);
    expect(second).toMatch(/Your last brief was a note about the visitor/);
    expect(second).toMatch(/first-person build request/);
  });

  it("with the key off, never retries or adds a note", async () => {
    briefKeyOff();
    createMock.mockResolvedValue(reply({ brief: TICKET_MEMO }));
    await summarize();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].messages[0].content).not.toMatch(/Your last brief/);
  });

  it("the fallback keeps tapped and typed answers as clean sentences", async () => {
    createMock.mockResolvedValue(reply({ brief: TICKET_MEMO }));
    const history = [
      {
        role: "agent" as const,
        text: "Pickup or delivery?",
        options: ["Pickup only", "Delivery in Austin", "Both"],
      },
      { role: "user" as const, text: "pickup only" },
      {
        role: "agent" as const,
        text: "How far ahead do people order?",
        options: ["Same day", "A few days", "A week or more"],
      },
      { role: "user" as const, text: "at least two days ahead, sometimes a week;" },
    ];
    const { json } = await summarize(BAKERY, history);
    const brief = json.mock.calls[0][0].brief as string;
    expect(brief).toBe(`Build this for me: ${BAKERY} Pickup only. At least two days ahead, sometimes a week.`);
    expect(brief).not.toMatch(/Details:|Pickup or delivery|;/i);
  });

  it("the fallback ends an unpunctuated seed with a full stop", async () => {
    createMock.mockResolvedValue(reply({ brief: TICKET_MEMO }));
    const { json } = await summarize("a booking site for my dog grooming van", [
      { role: "agent" as const, text: "Who books?" },
      { role: "user" as const, text: "regulars who text me today" },
    ]);
    expect(json.mock.calls[0][0].brief).toBe(
      "Build this for me: A booking site for my dog grooming van. Regulars who text me today.",
    );
  });
});

describe("DEL-1323 B9 review follow-ups: memo false positives, sticky rejection, fallback answers", () => {
  beforeEach(() => {
    createMock.mockReset();
    getBoolSetting.mockReset();
    getBoolSetting.mockResolvedValue(true);
    __test.resetLimits();
  });

  it.each([
    ["Build a booking site for my salon. The visitor picks a stylist and a time.", false],
    ["Build a dashboard that shows what the user needs to reorder each week.", false],
    ["Build an app where the user wants alerts when stock is low.", false],
    [TICKET_MEMO, true],
    ["The visitor wants a bakery website with a menu.", true],
    ["Build a bakery site; the visitor is seeking a cheap option.", true],
  ])("%s -> caught=%s", (brief, caught) => {
    expect(briefIsNotABuildPrompt(brief)).toBe(caught);
  });

  it("serves the fallback brief when the retry after a memo hits an upstream error", async () => {
    createMock
      .mockResolvedValueOnce(reply({ brief: TICKET_MEMO }))
      .mockRejectedValueOnce(Object.assign(new Error("overloaded"), { status: 529 }));
    const { status, json } = await summarize();
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(status).not.toHaveBeenCalled();
    expect(json.mock.calls[0][0].brief).toMatch(/^Build this for me: /);
  });

  it("serves the fallback brief when the retry after a memo is unparseable", async () => {
    createMock
      .mockResolvedValueOnce(reply({ brief: TICKET_MEMO }))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "" }] });
    const { status, json } = await summarize();
    expect(status).not.toHaveBeenCalled();
    expect(json.mock.calls[0][0].brief).toMatch(/^Build this for me: /);
  });

  it("serves the fallback brief when the retry after a memo times out", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const c = new AbortController();
      setTimeout(() => c.abort(new Error("timed out")), 20);
      return c.signal;
    });
    createMock
      .mockResolvedValueOnce(reply({ brief: TICKET_MEMO }))
      .mockImplementationOnce(() => new Promise(() => {}));
    const { status, json } = await summarize();
    timeout.mockRestore();
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(status).not.toHaveBeenCalled();
    expect(json.mock.calls[0][0].brief).toMatch(/^Build this for me: /);
  });

  it("the fallback skips trivial and redirecting answers but keeps tapped options", async () => {
    createMock.mockResolvedValue(reply({ brief: TICKET_MEMO }));
    const history = [
      { role: "agent" as const, text: "Pickup or delivery?", options: ["Delivery in Austin", "Pickup only"] },
      { role: "user" as const, text: "Delivery in Austin" },
      { role: "agent" as const, text: "Take deposits?" },
      { role: "user" as const, text: "Yes" },
      { role: "agent" as const, text: "Anything else?" },
      { role: "user" as const, text: "IDK." },
      { role: "user" as const, text: "ok" },
      { role: "user" as const, text: "Not sure" },
      { role: "agent" as const, text: "Which path?", options: ["Just get you live fast on existing platform"] },
      { role: "user" as const, text: "Just get you live fast on existing platform" },
      { role: "user" as const, text: "gift cards too" },
    ];
    const { json } = await summarize(BAKERY, history);
    expect(json.mock.calls[0][0].brief).toBe(
      `Build this for me: ${BAKERY} Delivery in Austin. Gift cards too.`,
    );
  });
});
