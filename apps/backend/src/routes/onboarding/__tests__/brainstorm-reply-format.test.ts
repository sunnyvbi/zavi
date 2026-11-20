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

import { onboardingBrainstorm, __test } from "../brainstorm";

const YOGA =
  "I teach yoga in Pune and just want a simple website with my class timetable and a way for students to book a class. Honestly is a Squarespace or Wix template cheaper and faster for this?";

const PROSE =
  "A template gets you a page, but the part that matters here is a timetable students can actually book from, and Zavi builds that for you. How many classes do you run in a week, and do students pay when they book?";

function text(t: string) {
  return { content: [{ type: "text", text: t }], stop_reason: "end_turn" };
}

function mockRes() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { status, json } as unknown as Response, status, json };
}

function req(body: object): Request {
  return { body, headers: {}, ip: "192.0.2.44", socket: { remoteAddress: "192.0.2.44" } } as unknown as Request;
}

async function send(body: object) {
  const r = mockRes();
  await onboardingBrainstorm(req(body), r.res);
  return r;
}

function userMsgOf(call: number): string {
  return createMock.mock.calls[call][0].messages[0].content as string;
}

describe("brainstorm survives a model reply that breaks the <reply> format", () => {
  beforeEach(() => {
    createMock.mockReset();
    getBoolSetting.mockReset();
    getBoolSetting.mockResolvedValue(true);
    __test.resetLimits();
  });

  it("serves plain untagged prose answering the Squarespace/Wix question as the reply on the first attempt", async () => {
    createMock.mockResolvedValue(text(PROSE));
    const { status, json } = await send({ seedIdea: YOGA, history: [], mode: "chat" });
    expect(status).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
    const body = json.mock.calls[0][0];
    expect(body.ok).toBe(true);
    expect(body.done).toBe(false);
    expect(body.message).toBe(PROSE);
    expect(body.options).toBeUndefined();
  });

  it("answers mid-conversation when the model opens <reply> and runs out of tokens inside the JSON", async () => {
    const truncated =
      '<reply>{"message": "Zavi builds the timetable and booking page for you, so students book straight from it. Do you want students to pay when they book, or pay at the stu';
    createMock.mockResolvedValue(text(truncated));
    const { status, json } = await send({
      seedIdea: "A website for my yoga classes in Pune",
      history: [
        { role: "agent", text: "What should a student be able to do on the site?" },
        { role: "user", text: YOGA },
      ],
      mode: "chat",
    });
    expect(status).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
    const body = json.mock.calls[0][0];
    expect(body.message).toBe(
      "Zavi builds the timetable and booking page for you, so students book straight from it.",
    );
    expect(body.message).not.toMatch(/<reply|"message"|\{|pay at the stu/);
    expect(body.user_turns).toBe(1);
  });

  it("parses a complete JSON reply that lost its tags or kept only the closing one", async () => {
    const obj = {
      message: "A booking page is the core of this. Which do students need most?",
      options: ["Book a class", "See the timetable", "Pay online"],
      recommended: "Book a class",
    };
    createMock
      .mockResolvedValueOnce(text("```json\n" + JSON.stringify(obj) + "\n```"))
      .mockResolvedValueOnce(text(`${JSON.stringify(obj)}</reply>`));
    const first = await send({ seedIdea: YOGA, history: [], mode: "chat" });
    __test.resetLimits();
    const second = await send({ seedIdea: YOGA, history: [], mode: "chat" });
    for (const { status, json } of [first, second]) {
      expect(status).not.toHaveBeenCalled();
      const body = json.mock.calls[0][0];
      expect(body.message).toBe(obj.message);
      expect(body.options).toEqual(obj.options);
      expect(body.recommended).toBe("Book a class");
    }
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("still keeps an untagged reply that sends the visitor to Wix off the screen and returns the build fallback", async () => {
    createMock.mockResolvedValue(
      text("Honestly, a Squarespace or Wix template is cheaper and faster for a timetable and bookings. You'd be better off with Wix here."),
    );
    const { status, json } = await send({ seedIdea: YOGA, history: [], mode: "chat" });
    expect(status).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(2);
    const body = json.mock.calls[0][0];
    expect(body.ok).toBe(true);
    expect(body.message).toMatch(/Zavi can build this/);
    expect(JSON.stringify(body)).not.toMatch(/squarespace|wix/i);
  });

  it("retries an unusable reply with a format repair and serves the repaired answer", async () => {
    const good = { message: "Zavi builds this. Do students pay when they book?", options: null, recommended: null };
    createMock
      .mockResolvedValueOnce(text('<reply>{"options": ["a", "b"]'))
      .mockResolvedValueOnce(text(`<reply>${JSON.stringify(good)}</reply>`));
    const { status, json } = await send({ seedIdea: YOGA, history: [], mode: "chat" });
    expect(status).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(userMsgOf(1).length).toBeGreaterThan(userMsgOf(0).length);
    expect(userMsgOf(1).startsWith(userMsgOf(0))).toBe(true);
    expect(json.mock.calls[0][0].message).toBe(good.message);
  });

  it("returns the try-again 502 when the model sends nothing usable on both attempts", async () => {
    createMock.mockResolvedValue(text("<reply></reply>"));
    const { status, json } = await send({ seedIdea: YOGA, history: [], mode: "chat" });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledWith(502);
    expect(json.mock.calls[0][0].error).toEqual({
      code: "parse_error",
      message: "Zavi couldn't answer just now. Try again in a moment.",
    });
  });

  it("serves an untagged prose brief in summarize mode", async () => {
    const brief =
      "Build a website for my yoga classes in Pune with my weekly class timetable and a way for students to book a class.";
    createMock.mockResolvedValue(text(brief));
    const { status, json } = await send({
      seedIdea: YOGA,
      history: [{ role: "user", text: "Weekly timetable and booking" }],
      mode: "summarize",
    });
    expect(status).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0][0]).toEqual({ ok: true, mode: "summarize", brief });
  });
});
