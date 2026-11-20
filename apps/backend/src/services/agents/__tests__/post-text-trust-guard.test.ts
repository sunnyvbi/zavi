
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn<unknown[], Promise<void>>(async () => {}),
}));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: mocks.logEvent,
}));

import {
  isTrustShapedAsk,
  containsTrustLeak,
  applyTrustGuardSync,
  applyTrustGuard,
  extractUserMessageFromPayload,
  TRUST_SHAPED_ASK_PATTERNS,
} from "../post-text-trust-guard";

describe("isTrustShapedAsk — positive cases", () => {
  it.each([
    "what model powers you?",
    "Which AI model do you use",
    "Who runs you under the hood?",
    "Are you using Claude or GPT-4?",
    "are you built on Anthropic?",
    "Are you SOC 2 compliant?",
    "Do you have a SOC 2 Type II cert?",
    "What's your GDPR posture?",
    "Can staff see my data?",
    "Do engineers access user messages?",
    "Do admins debug customer chats?",
    "How long do you retain my data?",
    "What's your data deletion policy?",
  ])("matches: %s", (text) => {
    expect(isTrustShapedAsk(text)).toBe(true);
  });
});

describe("isTrustShapedAsk — negative cases", () => {
  it.each([
    "what's our GMV this week?",
    "count open P1 bugs",
    "draft a marketing email",
    "fix the checkout bug",
    "summarize the last 5 host signups",
    "",
  ])("does NOT match: %s", (text) => {
    expect(isTrustShapedAsk(text)).toBe(false);
  });

  it("handles non-string input safely", () => {
    // @ts-expect-error runtime guard
    expect(isTrustShapedAsk(null)).toBe(false);
    // @ts-expect-error runtime guard
    expect(isTrustShapedAsk(undefined)).toBe(false);
  });
});

describe("containsTrustLeak — model_provider category", () => {
  it.each([
    "We use Claude",
    "Powered by Anthropic",
    "Running on GPT-4",
    "Built on ChatGPT",
    "Llama-3 backs this",
    "We rely on Gemini",
    "Using Grok behind the scenes",
  ])("flags: %s", (text) => {
    const r = containsTrustLeak(text);
    expect(r.leaked).toBe(true);
    expect(r.category).toBe("model_provider");
  });
});

describe("containsTrustLeak — soc2 category", () => {
  it.each([
    "We are SOC 2 Type II certified",
    "Yes, we are SOC 2 compliant",
    "No, we are not GDPR certified",
    "We're HIPAA compliant",
  ])("flags: %s", (text) => {
    const r = containsTrustLeak(text);
    expect(r.leaked).toBe(true);
    expect(r.category).toBe("soc2");
  });
});

describe("containsTrustLeak — staff_access category", () => {
  it.each([
    "Staff can read your data",
    "Engineers cannot view customer messages",
    "Admins may debug your conversations",
  ])("flags: %s", (text) => {
    const r = containsTrustLeak(text);
    expect(r.leaked).toBe(true);
    expect(r.category).toBe("staff_access");
  });
});

describe("containsTrustLeak — retention category", () => {
  it.each([
    "We retain your data for 90 days",
    "We store customer messages for 12 months",
    "We keep data for 2 years",
  ])("flags: %s", (text) => {
    const r = containsTrustLeak(text);
    expect(r.leaked).toBe(true);
    expect(r.category).toBe("retention");
  });
});

describe("containsTrustLeak — non-leak benign mentions", () => {
  it.each([
    "Your Stripe payout landed at 9am",
    "We have 14 open bugs",
    "Marketing draft is ready for review",
  ])("does NOT flag: %s", (text) => {
    expect(containsTrustLeak(text).leaked).toBe(false);
  });
});

describe("applyTrustGuardSync — scope + replacement", () => {
  it("REPLACES leaked output when operator + trust ask + leak", () => {
    const out = applyTrustGuardSync({
      agent_slug: "operator",
      user_message: "what model do you use",
      agent_text: "We use Claude by Anthropic.",
    });
    expect(out.fired).toBe(true);
    expect(out.category).toBe("model_provider");
    expect(out.text).toMatch(/security team/i);
    expect(out.text).not.toMatch(/claude|anthropic/i);
  });

  it("does NOT fire for non-operator agents", () => {
    const out = applyTrustGuardSync({
      agent_slug: "engineer",
      user_message: "what model do you use",
      agent_text: "We use Claude by Anthropic.",
    });
    expect(out.fired).toBe(false);
    expect(out.text).toBe("We use Claude by Anthropic.");
  });

  it("does NOT fire on non-trust-shaped asks", () => {
    const out = applyTrustGuardSync({
      agent_slug: "operator",
      user_message: "count P1 bugs",
      agent_text: "We have 3 P1 bugs.",
    });
    expect(out.fired).toBe(false);
  });

  it("does NOT fire when the prompt-rule already produced the canonical deflection", () => {
    const out = applyTrustGuardSync({
      agent_slug: "operator",
      user_message: "what model do you use",
      agent_text:
        "Our model stack is covered under our DPA, not chat. Want me to route you to security?",
    });
    expect(out.fired).toBe(false);
  });
});

describe("applyTrustGuardSync — ChatGPT / OpenAI as an ad channel", () => {
  it("a direct ChatGPT ad ask and its reply pass untouched", () => {
    const reply = "Your $25 ChatGPT ad is live for 1 day. ChatGPT Ads will stop it at $25.";
    for (const user_message of ["Run a $25 ChatGPT ad for 1 day", "Launch OpenAI ads for $50"]) {
      expect(isTrustShapedAsk(user_message)).toBe(false);
      expect(applyTrustGuardSync({ agent_slug: "operator", user_message, agent_text: reply })).toEqual({ text: reply, fired: false });
    }
    expect(containsTrustLeak(reply).leaked).toBe(false);
  });
  it("a model-disclosure question is still guarded, ChatGPT named or not", () => {
    const out = applyTrustGuardSync({ agent_slug: "operator", user_message: "what model do you use, ChatGPT?", agent_text: "We run on ChatGPT." });
    expect(out.fired).toBe(true);
    expect(out.category).toBe("model_provider");
    expect(isTrustShapedAsk("are you ChatGPT")).toBe(true);
  });
});

describe("extractUserMessageFromPayload — trigger shape coverage", () => {
  it("returns user_message for chat-trigger payloads", () => {
    expect(
      extractUserMessageFromPayload({ user_message: "hi", thread_id: "t-1" }),
    ).toBe("hi");
  });

  it("returns slack.text for slack-trigger payloads", () => {
    expect(
      extractUserMessageFromPayload({
        slack: { text: "what model powers you", channel_id: "C1" },
      }),
    ).toBe("what model powers you");
  });

  it("returns email body for email-trigger payloads", () => {
    expect(
      extractUserMessageFromPayload({
        email: { body: "are you SOC 2?", subject: "trust" },
      }),
    ).toBe("are you SOC 2?");
  });

  it("falls back to task_description / intent / text / prompt", () => {
    expect(extractUserMessageFromPayload({ task_description: "x" })).toBe("x");
    expect(extractUserMessageFromPayload({ intent: "y" })).toBe("y");
    expect(extractUserMessageFromPayload({ text: "z" })).toBe("z");
    expect(extractUserMessageFromPayload({ prompt: "w" })).toBe("w");
  });

  it("returns empty string when payload is null / undefined / malformed", () => {
    expect(extractUserMessageFromPayload(null)).toBe("");
    expect(extractUserMessageFromPayload(undefined)).toBe("");
    expect(extractUserMessageFromPayload({})).toBe("");
    expect(extractUserMessageFromPayload({ random: 1 })).toBe("");
  });
});

describe("applyTrustGuard — async wrapper + telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs low_conf_trust_seatbelt_fired with category on fire", async () => {
    await applyTrustGuard({
      tenant_id: "tenant-1",
      run_id: "run-abc",
      agent_slug: "operator",
      user_message: "what model do you use",
      agent_text: "We use Claude by Anthropic.",
    });
    await Promise.resolve();
    expect(mocks.logEvent).toHaveBeenCalledTimes(1);
    const call = mocks.logEvent.mock.calls[0]?.[0] as
      | {
          code: string;
          tenant_id: string;
          meta?: { category?: string };
        }
      | undefined;
    expect(call).toBeDefined();
    expect(call!.code).toBe("low_conf_trust_seatbelt_fired");
    expect(call!.tenant_id).toBe("tenant-1");
    expect(call!.meta?.category).toBe("model_provider");
  });

  it("does NOT log when guard is a no-op (scope-bound)", async () => {
    await applyTrustGuard({
      tenant_id: "tenant-1",
      run_id: "run-abc",
      agent_slug: "engineer",
      user_message: "what model do you use",
      agent_text: "We use Claude.",
    });
    await Promise.resolve();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

describe("TRUST_SHAPED_ASK_PATTERNS sanity", () => {
  it("every pattern is a RegExp", () => {
    for (const p of TRUST_SHAPED_ASK_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });
});
