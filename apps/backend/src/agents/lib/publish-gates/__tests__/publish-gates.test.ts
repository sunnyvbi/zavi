import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import type { ToolCallTrace } from "@/services/tools/types";
import { readRunEvidence, normaliseThreadUrl } from "../run-evidence";
import { applyIdentityGate, readsAsComplaintReply } from "../identity-gate";
import {
  applyCommunityRulesGate,
  brandFreeVariant,
  redditRulesProvider,
  providerFor,
} from "../community-rules-gate";
import { applyPublishGates, applyEditsToReport } from "../index";

const THREAD = "https://www.reddit.com/r/SanJose/comments/1obuoir/plumber_recommendation/";

function call(p: Partial<ToolCallTrace>): ToolCallTrace {
  return { name: "x", input_preview: "", output_preview: "", ms: 0, status: "ok", ...p } as ToolCallTrace;
}

function ctx(tenant = "t1") {
  return { tenant_id: tenant, runId: "r1", agent: { slug: "reddit_organic" } } as never;
}

function envelope(steps: unknown[]) {
  return { rendered_markdown: "# report", steps };
}

function step(content: string, extra: Record<string, unknown> = {}) {
  return {
    title: "Answer the thread",
    body: "Why this thread",
    blocking: false,
    effort: "minutes",
    evidence: ["read this run"],
    deliverable: { kind: "comment", label: "Answer", content, ...extra },
  };
}

const deps = {
  enabled: () => true,
  companyNames: async () => ["Counsil Plumbing", "counsilplumbing.com", "counsilplumbing"],
};

describe("the posted-rules check reads common ban wordings as banned", () => {
  const verdictFor = (rules: string) =>
    redditRulesProvider.resolve(
      "sub",
      readRunEvidence([
        call({
          name: "mcp__server__apify__scrape_reddit",
          output_preview: JSON.stringify({ mode: "community_rules", subreddit: "sub", rules_text: rules }),
        }),
      ]),
    );

  it.each([
    "1. No blogspam or self-promotion.",
    "Self-promotion is not permitted outside the weekly thread.",
    "No promotional posts. Ask questions only.",
    "Rule 3: self promo is forbidden",
  ])("%s", (rules) => {
    expect(verdictFor(rules)).toBe("banned");
  });

  it.each([
    "Ask anything. Contractors welcome.",
    "Share what you are building. Max 1 mention every 60 days.",
    "Promote your launch in the Saturday thread.",
    "No spam; self-promotion Saturdays are fine.",
    "No reposts, self-promo allowed in the weekly thread.",
    "There's no problem with self-promotion if you disclose.",
    "No marketing questions; ask in r/marketing.",
  ])("leaves a community that allows it permitted: %s", (rules) => {
    expect(verdictFor(rules)).toBe("permitted");
  });
});

describe("run evidence keys that must match however the URL or name was spelled", () => {
  it("counts a read thread for the card's link with no title, an old. host or a comment permalink", () => {
    const ev = readRunEvidence([
      call({ name: "mcp__server__reddit__thread_read", input_preview: `{"url":"${THREAD}"}`, output_preview: '{"found":true,"content":"..."}' }),
    ]);
    for (const spelling of [
      "https://www.reddit.com/r/SanJose/comments/1obuoir/",
      "https://old.reddit.com/r/sanjose/comments/1obuoir/plumber_recommendation/?utm_source=share",
      "https://reddit.com/r/SanJose/comments/1obuoir",
    ]) {
      expect(ev.threadsRead.has(normaliseThreadUrl(spelling)), spelling).toBe(true);
    }
    expect(ev.threadsRead.has(normaliseThreadUrl("https://www.reddit.com/r/SanJose/comments/2zzzzz/other/"))).toBe(false);
  });

  it("finds rules the actor returned under an r/ name when the gate looks up the bare name", () => {
    const ev = readRunEvidence([
      call({
        name: "mcp__server__apify__scrape_reddit",
        output_preview: '{"mode":"community_rules","subreddit":"r/webdev","rules_text":"# Posting Guidelines. 4. No self-promotion."}',
      }),
    ]);
    expect(ev.rulesByCommunity.get("webdev")?.complete).toBe(true);
  });
});

describe("run evidence: what the run actually read", () => {
  it("counts a thread as read only when the tool confirmed the fetch", () => {
    const ev = readRunEvidence([
      call({ name: "mcp__server__reddit__thread_read", input_preview: `{"url":"${THREAD}"}`, output_preview: '{"found":true,"content":"..."}' }),
      call({ name: "mcp__server__reddit__thread_read", input_preview: '{"url":"https://www.reddit.com/r/x/comments/zzz/t/"}', output_preview: '{"error":"reddit_thread_unread"}', status: "tool_error" }),
      call({ name: "mcp__server__web_search__search", output_preview: `{"results":[{"url":"${THREAD}"}]}` }),
    ]);
    expect(ev.threadsRead.has(normaliseThreadUrl(THREAD))).toBe(true);
    expect(ev.threadsRead.size).toBe(1);
  });

  it("treats truncated rules text as unread, never as permitted", () => {
    const ev = readRunEvidence([
      call({
        name: "mcp__server__apify__scrape_reddit",
        output_preview: '{"mode":"community_rules","subreddit":"webdev","rules_text":"# Posting Guidelines 1. No...","_truncated":true}',
      }),
    ]);
    expect(ev.rulesByCommunity.get("webdev")?.complete).toBe(false);
    expect(redditRulesProvider.resolve("webdev", ev)).toBe("unread");
  });

  it("keeps each community's own rules, never a sibling's", () => {
    const ev = readRunEvidence([
      call({
        name: "mcp__server__apify__scrape_reddit",
        output_preview:
          '{"communities":[{"name":"webdev","description":"No self-promotion of any kind."},{"name":"Web_Development","description":"Web Development news and tools."}]}',
      }),
    ]);
    expect(ev.rulesByCommunity.get("webdev")?.text).toMatch(/No self-promotion/);
    expect(ev.rulesByCommunity.get("web_development")?.text).toMatch(/news and tools/);
    expect(redditRulesProvider.resolve("webdev", ev)).toBe("banned");
    expect(redditRulesProvider.resolve("web_development", ev)).toBe("permitted");
  });
});

describe("identity gate", () => {
  const counsil =
    "Full disclosure, I'm Mike Counsil and I run Counsil Plumbing. That's on us, and I'll personally look into what happened. " +
    "For a water heater that fails this early, ask whoever installed it for the model number and the install date before anything else. " +
    "A unit under warranty is repaired free, and the paperwork is what proves it.";

  it("rewrites the named-person disclosure to the company role and drops the fault admission", () => {
    const r = applyIdentityGate({
      content: counsil,
      companyNames: ["Counsil Plumbing", "counsilplumbing.com"],
      isReply: true,
      threadUrl: normaliseThreadUrl(THREAD),
      threadsRead: new Set([normaliseThreadUrl(THREAD)]),
    });
    expect(r.content).not.toMatch(/Mike Counsil/);
    expect(r.content).toMatch(/I work at Counsil Plumbing/);
    expect(r.content).not.toMatch(/that'?s on us/i);
    expect(r.content).not.toMatch(/personally look into/i);
    expect(r.content).toMatch(/model number and the install date/);
    expect(r.edits.map((e) => e.rule)).toEqual(["named_person_disclosure", "blame_admission"]);
    expect(r.hold).toBeUndefined();
  });

  it("holds a complaint reply when the run never read the thread", () => {
    const r = applyIdentityGate({
      content: counsil,
      companyNames: ["Counsil Plumbing"],
      isReply: true,
      threadUrl: normaliseThreadUrl(THREAD),
      threadsRead: new Set(),
    });
    expect(r.hold).toBe("complaint_thread_unread");
  });

  it("leaves a company-only disclosure alone", () => {
    const ok = "Full disclosure, I work at Plausible. The dashboard is one page, and that is the whole product.";
    const r = applyIdentityGate({
      content: ok,
      companyNames: ["Plausible", "plausible.io"],
      isReply: false,
      threadsRead: new Set(),
    });
    expect(r.content).toBe(ok);
    expect(r.edits).toEqual([]);
  });

  it("does not hold an ordinary apology that is not answering a complaint", () => {
    const polite = "Sorry for the wall of text. The short version is that a cookieless tool needs no consent banner.";
    expect(readsAsComplaintReply(polite)).toBe(false);
    const r = applyIdentityGate({
      content: polite,
      companyNames: ["Plausible"],
      isReply: true,
      threadsRead: new Set(),
    });
    expect(r.hold).toBeUndefined();
    expect(r.content).toBe(polite);
  });

  it("does not rewrite a story that merely names a person", () => {
    const story = "A plumber named Mike Counsil replaced my heater in 2019 and it still runs fine today.";
    const r = applyIdentityGate({
      content: story,
      companyNames: ["Counsil Plumbing"],
      isReply: false,
      threadsRead: new Set(),
    });
    expect(r.content).toBe(story);
  });
});

describe("community-rules gate", () => {
  const branded =
    "Full disclosure, I work at Plausible. For the 'I just want to see my stats' case, a one-page dashboard covers it. " +
    "Whatever you pick, check whether it sets cookies: that is what forces the consent banner. " +
    "Umami self-hosted is free if you have somewhere to run it, and Matomo has a cookieless mode.";

  const evidenceBanned = readRunEvidence([
    call({
      name: "mcp__server__apify__scrape_reddit",
      output_preview: '{"mode":"community_rules","subreddit":"webdev","rules_text":"# Posting Guidelines. 4. No self-promotion."}',
    }),
  ]);

  it("rewrites branded copy brand-free when the community forbids promotion", () => {
    const r = applyCommunityRulesGate({
      channel: "reddit_organic",
      content: branded,
      presentation: { type: "reddit_reply", subreddit: "webdev" },
      companyNames: ["Plausible", "plausible.io"],
      evidence: evidenceBanned,
    });
    expect(r.verdict).toBe("banned");
    expect(r.brandFree).toBe(true);
    expect(r.content).not.toMatch(/Plausible/i);
    expect(r.content).toMatch(/consent banner/);
    expect(r.hold).toBeUndefined();
  });

  it("treats unread rules exactly like a ban", () => {
    const r = applyCommunityRulesGate({
      channel: "reddit_organic",
      content: branded,
      presentation: { type: "reddit_reply", subreddit: "espresso" },
      companyNames: ["Plausible"],
      evidence: evidenceBanned,
    });
    expect(r.verdict).toBe("unread");
    expect(r.brandFree).toBe(true);
  });

  it("ships unchanged when the read rules permit promotion", () => {
    const ev = readRunEvidence([
      call({
        name: "mcp__server__apify__scrape_reddit",
        output_preview: '{"mode":"community_rules","subreddit":"saas","rules_text":"Share what you are building. Max 1 mention every 60 days."}',
      }),
    ]);
    const r = applyCommunityRulesGate({
      channel: "reddit_organic",
      content: branded,
      presentation: { type: "reddit_reply", subreddit: "saas" },
      companyNames: ["Plausible"],
      evidence: ev,
    });
    expect(r.verdict).toBe("permitted");
    expect(r.content).toBe(branded);
  });

  it("holds instead of shipping a stub when stripping leaves nothing usable", () => {
    const allBrand = "Plausible is the simplest option. Plausible starts at $9. Try Plausible.";
    const r = applyCommunityRulesGate({
      channel: "reddit_organic",
      content: allBrand,
      presentation: { type: "reddit_reply", subreddit: "webdev" },
      companyNames: ["Plausible"],
      evidence: evidenceBanned,
    });
    expect(r.hold).toBe("rules_unread_no_brandfree_variant");
    expect(r.content).toBe(allBrand);
  });

  it("does not strip on a channel with no rules source", () => {
    expect(providerFor("x_organic")).toBeNull();
    const r = applyCommunityRulesGate({
      channel: "x_organic",
      content: branded,
      companyNames: ["Plausible"],
      evidence: evidenceBanned,
    });
    expect(r.verdict).toBe("no_provider");
    expect(r.content).toBe(branded);
  });

  it("brandFreeVariant keeps the answer and drops only the plug", () => {
    const out = brandFreeVariant(branded, ["Plausible", "plausible.io"]);
    expect(out).not.toMatch(/Plausible/i);
    expect(out).toMatch(/Umami self-hosted/);
  });
});

describe("community-rules gate: founder bans, context targets, untargeted copy", () => {
  const branded =
    "Full disclosure, I work at Plausible. For the 'I just want to see my stats' case, a one-page dashboard covers it. " +
    "Whatever you pick, check whether it sets cookies: that is what forces the consent banner. " +
    "Umami self-hosted is free if you have somewhere to run it, and Matomo has a cookieless mode.";
  const brandFree =
    "Whatever you pick, check whether it sets cookies: that is what forces the consent banner. " +
    "Umami self-hosted is free if you have somewhere to run it, and Matomo has a cookieless mode.";
  const evidencePermitsSaas = readRunEvidence([
    call({
      name: "mcp__server__apify__scrape_reddit",
      output_preview: '{"mode":"community_rules","subreddit":"saas","rules_text":"Share what you are building. Max 1 mention every 60 days."}',
    }),
  ]);
  const evidenceBansWebdev = readRunEvidence([
    call({
      name: "mcp__server__apify__scrape_reddit",
      output_preview: '{"mode":"community_rules","subreddit":"webdev","rules_text":"# Posting Guidelines. 4. No self-promotion."}',
    }),
  ]);

  it.each([["saas"], ["r/SaaS"], ["/r/saas"], ["  SAAS "]])(
    "a community the founder marked banned (%j) is banned even when the run read permissive rules",
    (name) => {
      const r = applyCommunityRulesGate({
        channel: "reddit_organic",
        content: branded,
        presentation: { type: "reddit_reply", subreddit: "SaaS" },
        bannedCommunities: new Set([name]),
        companyNames: ["Plausible"],
        evidence: evidencePermitsSaas,
      });
      expect(r.verdict).toBe("banned");
      expect(r.brandFree).toBe(true);
      expect(r.content).not.toMatch(/Plausible/);
    },
  );

  it("a founder ban on a different community leaves this one permitted", () => {
    const r = applyCommunityRulesGate({
      channel: "reddit_organic",
      content: branded,
      presentation: { type: "reddit_reply", subreddit: "saas" },
      bannedCommunities: new Set(["saasy"]),
      companyNames: ["Plausible"],
      evidence: evidencePermitsSaas,
    });
    expect(r.verdict).toBe("permitted");
    expect(r.content).toBe(branded);
  });

  it("reads the target from the step context when the copy and presentation name none", () => {
    const r = applyCommunityRulesGate({
      channel: "reddit_organic",
      content: branded,
      context: "Why this thread https://www.reddit.com/r/webdev/comments/abc/x/",
      companyNames: ["Plausible"],
      evidence: evidenceBansWebdev,
    });
    expect(r.target?.toLowerCase()).toBe("webdev");
    expect(r.verdict).toBe("banned");
    expect(r.brandFree).toBe(true);
  });

  it("untargeted brand-free reddit_organic copy ships unchanged, as unread", () => {
    const r = applyCommunityRulesGate({
      channel: "reddit_organic",
      content: brandFree,
      companyNames: ["Plausible"],
      evidence: evidencePermitsSaas,
    });
    expect(r).toEqual({ content: brandFree, verdict: "unread", target: null });
  });

  it("untargeted branded reddit_organic copy fails closed: never ships with the brand in it", () => {
    const r = applyCommunityRulesGate({
      channel: "reddit_organic",
      content: branded,
      companyNames: ["Plausible"],
      evidence: evidencePermitsSaas,
    });
    expect(r.verdict).toBe("unread");
    expect(r.target).toBeNull();
    expect(r.content).not.toMatch(/Plausible/);
    expect(r.brandFree).toBe(true);

    const allBrand = "Plausible is the simplest option. Plausible starts at $9. Try Plausible.";
    const held = applyCommunityRulesGate({
      channel: "reddit_organic",
      content: allBrand,
      companyNames: ["Plausible"],
      evidence: evidencePermitsSaas,
    });
    expect(held.hold).toBe("rules_unread_no_brandfree_variant");
  });

  it("untargeted reddit_organic copy with no known company names is held, never shipped", () => {
    const r = applyCommunityRulesGate({
      channel: "reddit_organic",
      content: branded,
      companyNames: [],
      evidence: evidencePermitsSaas,
    });
    expect(r).toEqual({ content: branded, verdict: "unread", target: null, hold: "rules_unread_no_brandfree_variant" });
    expect(r.brandFree).toBeUndefined();
  });

  it("applyPublishGates drops the deliverable of untargeted copy when the company's names are unknown", async () => {
    const plain = step(counsil);
    const { envelope: out } = await applyPublishGates(envelope([plain]), ctx(), permitsSaas, {
      enabled: () => true,
      companyNames: async () => [],
      bannedCommunities: async () => [],
    });
    const first = (out as { steps: Array<{ body: string; deliverable?: unknown }> }).steps[0];
    expect(first.deliverable).toBeUndefined();
    expect(first.body).toMatch(/Held: that community's rules could not be read today/);
  });

  it("untargeted reddit_ads copy is still no_provider, unchanged", () => {
    const r = applyCommunityRulesGate({
      channel: "reddit_ads",
      content: branded,
      companyNames: ["Plausible"],
      evidence: evidencePermitsSaas,
    });
    expect(r).toEqual({ content: branded, verdict: "no_provider", target: null });
  });

  const saasReply = (content: string) =>
    step(content, {
      presentation: {
        type: "reddit_reply",
        subreddit: "saas",
        thread_title: "t",
        thread_url: "https://www.reddit.com/r/saas/comments/abc/x/",
        reply_style: "answer",
        rule_status: "ready",
        potential: { level: "moderate", confidence: "low", reasons: ["r"] },
      },
    });
  const permitsSaas = {
    tool_calls: [
      call({
        name: "mcp__server__apify__scrape_reddit",
        output_preview: '{"mode":"community_rules","subreddit":"saas","rules_text":"Share what you are building. Max 1 mention every 60 days."}',
      }),
    ],
  } as never;
  const counsil =
    "Full disclosure, I work at Counsil Plumbing. For a slab leak, get the shutoff located before anyone starts cutting, and ask for the camera footage afterwards so you can see what was actually replaced.";

  it("applyPublishGates reads the tenant's banned communities and strips the brand on a founder-banned community", async () => {
    const banned = vi.fn(async () => ["r/SaaS"]);
    const { envelope: out } = await applyPublishGates(envelope([saasReply(counsil)]), ctx("t9"), permitsSaas, {
      ...deps,
      bannedCommunities: banned,
    });
    expect(banned).toHaveBeenCalledWith("t9", "reddit_organic");
    const first = (out as { steps: Array<{ deliverable?: { content: string } }> }).steps[0];
    expect(first.deliverable?.content).not.toMatch(/Counsil Plumbing/);
    expect(first.deliverable?.content).toMatch(/shutoff/);
  });

  it("applyPublishGates treats an unreadable banned list as unread rules, never as permitted", async () => {
    const { envelope: out } = await applyPublishGates(envelope([saasReply(counsil)]), ctx(), permitsSaas, {
      ...deps,
      bannedCommunities: async () => {
        throw new Error("settings down");
      },
    });
    const first = (out as { steps: Array<{ deliverable?: { content: string } }> }).steps[0];
    expect(first.deliverable?.content).not.toMatch(/Counsil Plumbing/);
  });

  it("applyPublishGates ships the branded answer when the list reads fine and the community allows it", async () => {
    const { envelope: out } = await applyPublishGates(envelope([saasReply(counsil)]), ctx(), permitsSaas, {
      ...deps,
      bannedCommunities: async () => ["webdev"],
    });
    const first = (out as { steps: Array<{ deliverable?: { content: string } }> }).steps[0];
    expect(first.deliverable?.content).toBe(counsil);
  });
});

describe("composed transform", () => {
  const rulesUnreadResult = { tool_calls: [] } as never;

  it("adds a no-move step when nothing branded survived", async () => {
    const { envelope: out } = await applyPublishGates(
      envelope([step("Full disclosure, I work at Counsil Plumbing. For a slab leak, get the shutoff located before anyone starts cutting, and ask for the camera footage afterwards so you can see what was actually replaced.", { presentation: { type: "reddit_reply", subreddit: "SanJose", thread_title: "t", thread_url: THREAD, reply_style: "answer", rule_status: "verify_manually", potential: { level: "moderate", confidence: "low", reasons: ["r"] } } })]),
      ctx(),
      rulesUnreadResult,
      deps,
    );
    const steps = (out as { steps: Array<{ title: string; deliverable?: { content: string } }> }).steps;
    expect(steps.some((s) => s.title === "No brand mention this week")).toBe(true);
    const answer = steps[0];
    expect(answer.deliverable?.content).not.toMatch(/Counsil Plumbing/);
    expect(answer.deliverable?.content).toMatch(/shutoff/);
  });

  it("adds no no-move step when a branded answer survived", async () => {
    const result = {
      tool_calls: [
        call({
          name: "mcp__server__apify__scrape_reddit",
          output_preview: '{"mode":"community_rules","subreddit":"plumbing","rules_text":"Ask anything. Contractors welcome."}',
        }),
      ],
    } as never;
    const { envelope: out } = await applyPublishGates(
      envelope([step("Full disclosure, I work at Counsil Plumbing. For a slab leak, get the shutoff located before anyone starts cutting.", { presentation: { type: "reddit_reply", subreddit: "plumbing", thread_title: "t", thread_url: THREAD, reply_style: "answer", rule_status: "ready", potential: { level: "moderate", confidence: "low", reasons: ["r"] } } })]),
      ctx(),
      result,
      deps,
    );
    const steps = (out as { steps: Array<{ title: string }> }).steps;
    expect(steps.some((s) => s.title === "No brand mention this week")).toBe(false);
  });

  it("names the unchecked target on a channel with no rules source", async () => {
    const { envelope: out } = await applyPublishGates(
      envelope([step("Reply in r/webdev mentioning Counsil Plumbing, with enough detail to be useful to the person asking about a slab leak.")]),
      { tenant_id: "t1", runId: "r1", agent: { slug: "x_organic" } } as never,
      rulesUnreadResult,
      deps,
    );
    const steps = (out as { steps: Array<{ title: string }> }).steps;
    expect(steps.some((s) => /Check the rules for webdev/.test(s.title))).toBe(true);
  });

  it("carries a brand-free rewrite into the report the founder reads", async () => {
    const branded =
      "Full disclosure, I work at Counsil Plumbing. For a slab leak, get the shutoff located before anyone starts cutting, and ask for the camera footage afterwards so you can see what was actually replaced. A leak under the slab is priced by access, not by the pipe.";
    const env = {
      rendered_markdown: `# This week\n\n## Answer 1\n\n${branded}\n\n## Notes\n\nnothing else`,
      steps: [step(branded, { presentation: { type: "reddit_reply", subreddit: "SanJose", thread_title: "t", thread_url: THREAD, reply_style: "answer", rule_status: "verify_manually", potential: { level: "moderate", confidence: "low", reasons: ["r"] } } })],
    };
    const { envelope: out } = await applyPublishGates(env, ctx(), { tool_calls: [] } as never, deps);
    const rm = (out as { rendered_markdown: string }).rendered_markdown;
    expect(rm).not.toMatch(/Counsil Plumbing/);
    expect(rm).toMatch(/shutoff/);
  });

  it("flags the report when the copy cannot be replaced exactly", () => {
    const out = applyEditsToReport("# Report\n\nA re-wrapped paraphrase of the answer.", [
      { from: "the exact original answer text", to: "brand-free" },
    ]);
    expect(out).toMatch(/changed or held by the publish checks/);
    expect(out).toMatch(/the cards win/);
  });

  it("holds branded copy when the company's own name is unknown", () => {
    const r = applyCommunityRulesGate({
      channel: "reddit_organic",
      content: "Full disclosure, I work at Plausible. The dashboard is one page and that is the whole product, which is the point.",
      presentation: { type: "reddit_reply", subreddit: "webdev" },
      companyNames: [],
      evidence: readRunEvidence([]),
    });
    expect(r.hold).toBe("rules_unread_no_brandfree_variant");
  });

  it("does not read a brand out of a longer word", () => {
    const content = "That is an implausible claim. Check whether the tool sets cookies, because that is what forces the banner.";
    expect(
      applyCommunityRulesGate({
        channel: "reddit_organic",
        content,
        presentation: { type: "reddit_reply", subreddit: "webdev" },
        companyNames: ["Plausible", "plausible.io"],
        evidence: readRunEvidence([]),
      }).content,
    ).toBe(content);
  });

  it("catches a disclosure with a name but no first-person verb", () => {
    const r = applyIdentityGate({
      content: "Full disclosure: Mike Counsil here from Counsil Plumbing. Get the shutoff located before anyone cuts drywall.",
      companyNames: ["Counsil Plumbing"],
      isReply: false,
      threadsRead: new Set(),
    });
    expect(r.content).not.toMatch(/Mike Counsil/);
    expect(r.content).toMatch(/I work at Counsil Plumbing/);
  });

  it("does not hold general advice that merely says sorry about refunds", () => {
    expect(
      readsAsComplaintReply("Sorry, a refund is rarely possible with most vendors once the trial ends."),
    ).toBe(false);
  });

  it("pairs each community with its own rules when the preview is valid JSON", () => {
    const ev = readRunEvidence([
      call({
        name: "mcp__server__apify__scrape_reddit",
        output_preview: JSON.stringify({
          communities: [
            { name: "espresso", description: 'Rule "A": self-promotion is not allowed.' },
            { name: "pourover", description: 'Rule "B": ask anything, vendors welcome.' },
          ],
        }),
      }),
    ]);
    expect(redditRulesProvider.resolve("espresso", ev)).toBe("banned");
    expect(redditRulesProvider.resolve("pourover", ev)).toBe("permitted");
  });

  it("is a no-op when the kill switch is off", async () => {
    const env = envelope([step("Full disclosure, I'm Mike Counsil and I run Counsil Plumbing. That's on us.")]);
    const { envelope: out } = await applyPublishGates(env, ctx(), rulesUnreadResult, {
      ...deps,
      enabled: () => false,
    });
    expect(out).toBe(env);
  });
});
