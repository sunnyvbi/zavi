import { describe, it, expect, vi, afterEach } from "vitest";
import {
  applyChatTextVerifiers,
  CHAT_TEXT_VERIFIER_IDS,
} from "../chat-text-verifiers";

const CAP_AGENT = "performance-marketer";
const BLOCKER_AGENT = "operator";

describe("applyChatTextVerifiers — arming", () => {
  it("flags an ungrounded cap for an allowlisted agent as telemetry — text unchanged", () => {
    const r = applyChatTextVerifiers({
      text: "Host campaigns are capped at $50/week.",
      toolCalls: [],
      agentSlug: CAP_AGENT,
    });

    expect(r.triggered.map((t) => t.id)).toContain("cap_grounding");
    expect(r.text).toBe("Host campaigns are capped at $50/week.");
    expect(r.metaPatch.cap_grounding_fired).toBe(true);
  });

  it("leaves the same reply untouched for a non-allowlisted agent", () => {
    const text = "Host campaigns are capped at $50/week.";
    const r = applyChatTextVerifiers({
      text,
      toolCalls: [],
      agentSlug: "qa",
    });

    expect(r.triggered.map((t) => t.id)).not.toContain("cap_grounding");
    expect(r.text).toBe(text);
  });

  it("returns a clean reply unchanged, with no triggers and an empty metaPatch", () => {
    const text = "I pulled the last 7 days of spend and nothing looks off.";
    const r = applyChatTextVerifiers({
      text,
      toolCalls: [],
      agentSlug: CAP_AGENT,
    });

    expect(r.text).toBe(text);
    expect(r.triggered).toEqual([]);
    expect(Object.keys(r.metaPatch)).toHaveLength(0);
  });

  it("no-ops on empty text without running any entry", () => {
    const r = applyChatTextVerifiers({ text: "", agentSlug: BLOCKER_AGENT });
    expect(r.text).toBe("");
    expect(r.triggered).toEqual([]);
  });
});

describe("applyChatTextVerifiers — event payloads", () => {
  it("tags each trigger with the same source/code the runner band emits", () => {
    const r = applyChatTextVerifiers({
      text: "Host campaigns are capped at $50/week.",
      toolCalls: [],
      agentSlug: CAP_AGENT,
    });

    const cap = r.triggered.find((t) => t.id === "cap_grounding");
    expect(cap?.source).toBe("agent.cap-grounding");
    expect(cap?.code).toBe("cap_grounding_hedged");
    expect(cap?.meta).toMatchObject({ agent_slug: CAP_AGENT });
    expect(JSON.stringify(cap?.meta)).not.toContain("capped at");
  });
});

describe("applyChatTextVerifiers — fail-open", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a throwing entry does not block the reply and does not skip later entries", async () => {
    const capMod = await import("../cap-grounding-verifier");
    vi.spyOn(capMod, "verifyCapGrounding").mockImplementation(() => {
      throw new Error("boom");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const text = "Host campaigns are capped at $50/week.";
    const r = applyChatTextVerifiers({
      text,
      toolCalls: [],
      agentSlug: CAP_AGENT,
    });

    expect(r.text).toBe(text);
    expect(r.triggered.map((t) => t.id)).not.toContain("cap_grounding");
    expect(warn).toHaveBeenCalled();
  });
});

describe("applyChatTextVerifiers — inventory", () => {
  it("exposes exactly the eight checks the chat seam owns", () => {
    expect([...CHAT_TEXT_VERIFIER_IDS].sort()).toEqual(
      [
        "action_claim",
        "cap_grounding",
        "capped_aggregate",
        "doc_only_claim",
        "fabricated_blocker",
        "roas_sample_grounding",
        "tool_broken_claim",
        "unverified_absence",
      ].sort(),
    );
  });
});
