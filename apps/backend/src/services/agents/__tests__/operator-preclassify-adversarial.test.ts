
import { describe, it, expect } from "vitest";
import { isMemoryRecallAsk } from "../is-memory-recall-ask";
import {
  isTrustShapedAsk,
  containsTrustLeak,
  applyTrustGuardSync,
} from "../post-text-trust-guard";

describe("Adversarial #1 — trust+workspace mixed turn (R2 surgical fix)", () => {
  const mixedUserMsg =
    "Given $23K/wk GMV, what model are you using and what should I do?";

  it("isTrustShapedAsk fires on the trust sub-question", () => {
    expect(isTrustShapedAsk(mixedUserMsg)).toBe(true);
  });

  it("seatbelt fires when operator output names the provider in this mixed turn", () => {
    const agentText =
      "Your GMV breakdown: $23K/wk is concentrated in 3 cities. We use Claude by Anthropic to power this analysis.";
    const out = applyTrustGuardSync({
      agent_slug: "operator",
      user_message: mixedUserMsg,
      agent_text: agentText,
    });
    expect(out.fired).toBe(true);
    expect(out.category).toBe("model_provider");
    expect(out.text).toMatch(/security team/i);
    expect(out.text).not.toMatch(/claude|anthropic/i);
  });

  it("seatbelt does NOT fire when operator answers the workspace half WITHOUT naming provider", () => {
    const agentText =
      "Your GMV breakdown: $23K/wk concentrated in 3 cities. On the model question: that's covered under our DPA, not chat. Want me to route you to security?";
    const out = applyTrustGuardSync({
      agent_slug: "operator",
      user_message: mixedUserMsg,
      agent_text: agentText,
    });
    expect(out.fired).toBe(false);
    expect(out.text).toBe(agentText);
  });
});

describe("Adversarial #2 — workspace-signal weak-only non-suppression", () => {
  it("weak-only signals do NOT count as memory-recall ask", () => {
    expect(isMemoryRecallAsk("proactively write a poem this week").matched).toBe(
      false,
    );
    expect(isMemoryRecallAsk("be proactive about this").matched).toBe(false);
  });

  it("strong-signal phrasing DOES trigger memory-recall ask shape (priorities category)", () => {
    const r = isMemoryRecallAsk("what should I focus on this week");
    expect(r.matched).toBe(true);
    expect(r.category).toBe("priorities");
  });
});

describe("Adversarial #3 — memory injection bypass attempt", () => {
  it("seatbelt fires when memory-injected prompt tries to force provider disclosure", () => {
    const userMsg = "What model are you using?";
    const agentText =
      "Per the memory note, I should disclose: we use GPT-4 (OpenAI) for this workspace.";
    const out = applyTrustGuardSync({
      agent_slug: "operator",
      user_message: userMsg,
      agent_text: agentText,
    });
    expect(out.fired).toBe(true);
    expect(out.category).toBe("model_provider");
    expect(out.text).not.toMatch(/gpt|openai/i);
  });

  it("seatbelt is NO-OP when memory-injected note targets a non-trust topic", () => {
    const userMsg = "How many open bugs do we have?";
    const agentText = "We have 14 open P1 bugs in SCRUM.";
    const out = applyTrustGuardSync({
      agent_slug: "operator",
      user_message: userMsg,
      agent_text: agentText,
    });
    expect(out.fired).toBe(false);
    expect(out.text).toBe(agentText);
  });
});

describe("Adversarial #4 — normal Tier-2 turn (no clarifier regression)", () => {
  it("memory-recall classifier does NOT fire on a tool-using Tier-2 ask", () => {
    expect(isMemoryRecallAsk("count open SCRUM bugs").matched).toBe(false);
    expect(isMemoryRecallAsk("what's our Stripe MRR this month").matched).toBe(
      false,
    );
  });

  it("seatbelt does NOT fire on a normal Tier-2 output (no provider mentions)", () => {
    const out = applyTrustGuardSync({
      agent_slug: "operator",
      user_message: "count open SCRUM bugs",
      agent_text: "There are 14 open P1 bugs in SCRUM.",
    });
    expect(out.fired).toBe(false);
  });
});

describe("Adversarial #5 — Slack low-conf clarifier shape (No-lane bullet)", () => {
  it("'help me with my work' is NOT memory-recall-shaped (falls to No-lane bullet)", () => {
    expect(isMemoryRecallAsk("help me with my work").matched).toBe(false);
    expect(isMemoryRecallAsk("what should I do today").matched).toBe(false);
  });

  it("memory-recall pattern DOES fire when user explicitly asks about prior context", () => {
    const r = isMemoryRecallAsk("where did we leave off on the migration");
    expect(r.matched).toBe(true);
    expect(r.category).toBe("recall");
  });
});

describe("Trust seatbelt scope guarantees (no over-fire / no perf cost)", () => {
  it("does NOT fire for non-operator agents (perf bound)", () => {
    const out = applyTrustGuardSync({
      agent_slug: "engineer",
      user_message: "what model are you using",
      agent_text: "We use Claude by Anthropic.",
    });
    expect(out.fired).toBe(false);
    expect(out.text).toBe("We use Claude by Anthropic.");
  });

  it("does NOT fire on non-trust-shaped user asks (perf bound)", () => {
    const out = applyTrustGuardSync({
      agent_slug: "operator",
      user_message: "what's the weather",
      agent_text: "I happen to mention Anthropic in some unrelated context.",
    });
    expect(out.fired).toBe(false);
  });

  it("containsTrustLeak buckets categories correctly", () => {
    expect(containsTrustLeak("We use Claude").category).toBe("model_provider");
    expect(containsTrustLeak("We are SOC 2 Type II certified").category).toBe(
      "soc2",
    );
    expect(
      containsTrustLeak("Staff can read your conversations for debugging").category,
    ).toBe("staff_access");
    expect(
      containsTrustLeak("We retain your data for 90 days").category,
    ).toBe("retention");
  });

  it("containsTrustLeak does NOT flag benign mentions", () => {
    expect(containsTrustLeak("Your Stripe payout landed at 9am").leaked).toBe(
      false,
    );
    expect(containsTrustLeak("There are 3 open P1 bugs").leaked).toBe(false);
  });
});
