import { describe, it, expect } from "vitest";
import {
  ASSISTANT_BLOCKED_AGENTS,
  assistantAdChangeNeedsPerson,
  isAdDecisionClass,
  assistantBlockedToolReason,
  isAssistantRun,
  withoutAssistantAiImages,
  withoutPurchasePrompts,
  assistantSafeRunError,
} from "../assistant-policy";
import {
  assistantVisibleRunError,
  providerOutageBody,
  usageLimitFailureBody,
  SEAT_FAILURE_BODY,
  GENERIC_FAILURE_BODY,
} from "@/services/agents/error-body";

describe("isAssistantRun", () => {
  it("is true only for the mcp trigger", () => {
    expect(isAssistantRun("mcp")).toBe(true);
    for (const t of ["chat", "slack", "cron", "a2a", "handoff", "manual", undefined, null]) {
      expect(isAssistantRun(t)).toBe(false);
    }
  });
});

describe("assistantBlockedToolReason", () => {
  it.each([
    ["report", "generate_image"],
    ["report", "render_social_image"],
    ["generated_video", "propose"],
    ["generated_video", "animate"],
    ["praxis", "render_video"],
    ["praxis", "render_launch_video"],
    ["higgsfield", "generate_video"],
    ["higgsfield", "generate_image"],
    ["higgsfield", "generate_audio"],
    ["stripe", "create_payment"],
    ["stripe", "remit_to_tenant"],
  ])("blocks %s/%s (AI media or money)", (server, tool) => {
    expect(assistantBlockedToolReason(server, tool)).toMatch(/not available on runs started from an AI assistant/i);
  });

  it.each([
    ["composio", "OPENAI_CREATE_IMAGE"],
    ["composio", "ELEVENLABS_TEXT_TO_SPEECH"],
    ["pipedream", "runway-image-to-video"],
    ["composio", "STRIPE_CREATE_PAYMENT_INTENT"],
    ["composio", "PAYPAL_CREATE_PAYOUT"],
    ["composio", "WISE_SEND_TRANSFER"],
  ])("blocks a connected app's media or money tool by name: %s/%s", (server, tool) => {
    expect(assistantBlockedToolReason(server, tool)).not.toBeNull();
  });

  it.each([
    ["report", "render_pdf"],
    ["report", "render_blog"],
    ["report", "render_deck"],
    ["google_ads", "propose_video_campaign"],
    ["meta_ads", "propose_budget_change"],
    ["social", "propose_post"],
    ["email", "send"],
    ["stripe", "list_charges"],
    ["stripe", "list_payouts"],
    ["stripe", "submit_dispute_evidence"],
    ["higgsfield", "list_voices"],
    ["composio", "GMAIL_SEND_EMAIL"],
    ["web_search", "search"],
  ])("leaves %s/%s available", (server, tool) => {
    expect(assistantBlockedToolReason(server, tool)).toBeNull();
  });
});

describe("ASSISTANT_BLOCKED_AGENTS", () => {
  it("refuses the AI video agent and nothing else", () => {
    expect([...ASSISTANT_BLOCKED_AGENTS]).toEqual(["generated_video"]);
  });
});

describe("withoutAssistantAiImages", () => {
  it("drops render_pdf's per-section AI photo prompts and keeps logos and text", () => {
    const args = {
      title: "Plan",
      sections: [
        { heading: "A", body: "x", image_concept: "a bike shop at dawn" },
        { heading: "B", body: "y", logo_spec: { svg: "<svg/>" }, image_concept: "ignored" },
        { heading: "C", body: "z" },
      ],
    };
    expect(withoutAssistantAiImages("report", "render_pdf", args)).toEqual({
      title: "Plan",
      sections: [
        { heading: "A", body: "x" },
        { heading: "B", body: "y", logo_spec: { svg: "<svg/>" } },
        { heading: "C", body: "z" },
      ],
    });
  });

  it("drops render_blog's hero image prompts", () => {
    expect(withoutAssistantAiImages("report", "render_blog", { title: "T", image_concepts: ["a", "b"] })).toEqual({
      title: "T",
    });
  });

  it("leaves every other tool's args untouched", () => {
    const args = { image_concepts: ["a"] };
    expect(withoutAssistantAiImages("report", "render_deck", args)).toBe(args);
    expect(withoutAssistantAiImages("social", "propose_post", args)).toBe(args);
  });
});

describe("withoutPurchasePrompts", () => {
  it.each([
    [{ code: "insufficient_credits", message: "You're out of credits. Top up in Billing to keep your agents running.", action: "top_up" }],
    [{ error: "plan_upgrade_required", required_tier: "pro", message: "Meta Ads needs the Pro plan ($240/mo). Tell the user they can upgrade on the Billing page." }],
    [{ status: "refused", reason: "insufficient_credits", message: "Tell the founder to top up, or they can run it at /start." }],
    [{ code: "build_credits_exhausted", message: "Top up in Billing to keep building.", action: "top_up" }],
  ])("makes %j informational", (refusal) => {
    const out = JSON.parse(withoutPurchasePrompts(JSON.stringify(refusal), true));
    expect(out.message).not.toMatch(/top up|upgrade|billing|\$/i);
    expect(out.action).toBeUndefined();
    for (const k of ["status", "required_tier"] as const) {
      if (k in refusal) expect(out[k]).toBe((refusal as Record<string, unknown>)[k]);
    }
  });

  it("drops purchase prose in other fields and nested data, keeping only machine fields", () => {
    const out = JSON.parse(
      withoutPurchasePrompts(
        JSON.stringify({
          code: "insufficient_credits",
          error: "Top up in Billing to continue",
          detail: { checkout: "https://pay.example/x", price: "$20" },
          retryable: false,
        }),
        true,
      ),
    );
    expect(JSON.stringify(out)).not.toMatch(/top up|billing|\$|checkout/i);
    expect(out.code).toBe("insufficient_credits");
    expect(out.retryable).toBe(false);
  });

  it("leaves successful results alone, even when they mention a refusal code", () => {
    const ok = JSON.stringify({ code: "plan_upgrade_required", message: "classification seen in logs", price: 20 });
    expect(withoutPurchasePrompts(ok, false)).toBe(ok);
    const refused = JSON.stringify({ status: "refused", reason: "insufficient_credits", message: "Tell the founder to top up." });
    expect(JSON.parse(withoutPurchasePrompts(refused, false)).message).not.toMatch(/top up/i);
  });

  it("leaves results that discuss pricing, other errors and non-JSON untouched", () => {
    const research = JSON.stringify({ summary: "Competitors charge $49/mo; upgrade paths are common." });
    const cap = JSON.stringify({ code: "budget_exceeded", message: "It resets tomorrow." });
    expect(withoutPurchasePrompts(research, true)).toBe(research);
    expect(withoutPurchasePrompts(cap, true)).toBe(cap);
    expect(withoutPurchasePrompts("plain text, top up", true)).toBe("plain text, top up");
    expect(withoutPurchasePrompts("[1,2]", true)).toBe("[1,2]");
  });
});

describe("assistantSafeRunError", () => {
  it("drops the plan price from an execution-gate error", () => {
    const e = "blocked at execution: plan_upgrade_required — Meta Ads needs the Pro plan ($240/mo).";
    expect(assistantSafeRunError(e)).not.toMatch(/\$|upgrade/i);
  });
  it("makes an out-of-credits error informational", () => {
    expect(assistantSafeRunError('Agent "seo" rejected: out of credits — top up to keep running')).not.toMatch(/top up/i);
    expect(assistantSafeRunError('dispatch_inner: Agent "seo" rejected: out of credits — top up to keep running')).not.toMatch(/top up/i);
    expect(assistantSafeRunError('Agent "engineer" rejected: no build credits remaining this period')).not.toMatch(/build credits remaining/);
  });
  it("drops the dollar cap from staff test-run and budget errors", () => {
    expect(assistantSafeRunError("blocked at execution: staff_model_refused — daily ?model= test cap reached ($50)")).not.toMatch(/\$/);
    expect(assistantSafeRunError('dispatch_inner: Agent "seo" rejected: tenant daily budget cap ($25) reached')).not.toMatch(/\$/);
  });
  it("leaves other errors as written, even ones that mention credits", () => {
    for (const e of [
      "blocked at execution: channel_retired — tiktok",
      "dispatch_inner: upstream said insufficient_credits on their side",
      "Meta API: account out of credits for boosts",
      "Meta API request rejected: out of credits",
      "blocked at execution: staff_model_refused — no authorizing user on the run",
      "dispatch_inner: Meta API request rejected: tenant daily budget cap ($25) reached",
    ]) {
      expect(assistantSafeRunError(e)).toBe(e);
    }
  });
});

describe("assistantAdChangeNeedsPerson", () => {
  const AD_CLASSES = [
    "meta_ads.update_ad_set_budget",
    "google_ads.update_campaign_budget",
    "tiktok_ads.create_launch",
    "reddit_ads.update_budget",
    "linkedin_ads.set_status",
    "x_ads.create_campaign",
    "chatgpt_ads.create_and_launch",
    "perfmkt.create_ad_set_pending_strategist",
  ];

  it("counts every ad platform's classes and the Ads Manager's own as ad changes", () => {
    for (const c of AD_CLASSES) expect(isAdDecisionClass(c)).toBe(true);
    for (const c of ["operator.post-slack-message", "engineer.ship-pr", "email_campaign.send", "social.post", "cgo.dispatch-specialist"]) {
      expect(isAdDecisionClass(c)).toBe(false);
    }
  });

  it("holds an ad change only on an assistant run", () => {
    for (const c of AD_CLASSES) expect(assistantAdChangeNeedsPerson("mcp", c)).toBe(true);
    for (const t of ["chat", "slack", "cron", "a2a", "handoff", "manual", "email", undefined, null]) {
      for (const c of AD_CLASSES) expect(assistantAdChangeNeedsPerson(t, c)).toBe(false);
    }
  });

  it("leaves an assistant run's other changes alone", () => {
    expect(assistantAdChangeNeedsPerson("mcp", "operator.post-slack-message")).toBe(false);
  });
});

describe("assistantVisibleRunError: provider outages read like the web chat", () => {
  it.each([
    "dispatch_inner: Claude Code returned an error result: Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access",
    "Your account does not have access to Claude. Please login again or contact your administrator.",
    "Claude Code returned an error result: API Error: 401 authentication_error",
  ])("hides the raw seat error behind the web seat copy: %s", (raw) => {
    const out = assistantVisibleRunError(raw);
    expect(out).toBe(SEAT_FAILURE_BODY);
    expect(out).not.toMatch(/API key|admin|organization|Claude/i);
  });

  it("maps a usage limit to the web copy, keeping the reset time", () => {
    const raw = "money-path run not auto-retried (c-1a2b3c): Claude Code returned an error result: You've hit your limit · resets 7pm (UTC)";
    const out = assistantVisibleRunError(raw);
    expect(out).toBe(usageLimitFailureBody(raw));
    expect(out).toMatch(/usage limit on the AI service/);
    expect(out).not.toMatch(/money-path|Claude Code|c-1a2b3c/);
  });

  it.each([
    'Claude Code returned an error result: API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    "dispatch_inner: API Error: 500 Internal server error",
  ])("maps a provider overload / 5xx to the web's generic line: %s", (raw) => {
    expect(assistantVisibleRunError(raw)).toBe(GENERIC_FAILURE_BODY);
  });

  it("keeps Zavi's out-of-credits sentence ahead of the usage-limit copy", () => {
    const raw = 'Agent "operator" rejected: out of credits — top up to keep running';
    const out = assistantVisibleRunError(raw);
    expect(out).toBe(assistantSafeRunError(raw));
    expect(out).not.toBe(raw);
    expect(out).not.toMatch(/usage limit on the AI service/);
  });

  it.each([
    "You've hit your limit · resets Sep 26 at 5:30am (Asia/Calcutta)",
    "Claude AI usage limit reached · resets 7pm (UTC)",
  ])("maps the bare provider cap notice too: %s", (raw) => {
    expect(assistantVisibleRunError(raw)).toBe(usageLimitFailureBody(raw));
  });

  it("leaves a customer connector's own auth, credit, quota and other errors as written", () => {
    for (const raw of [
      "meta_ads: OAuth access token has expired",
      "github: HTTP 500 from api.github.com",
      "Meta API: account out of credits for boosts",
      "google_ads: insufficient quota for this request",
      "Claude connector: account out of credits",
      "anthropic_api: insufficient credits on the connected key",
    ]) {
      expect(assistantVisibleRunError(raw)).toBe(raw);
      expect(providerOutageBody(raw)).toBeNull();
    }
  });
});
