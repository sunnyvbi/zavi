import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../knowledge", () => ({
  loadKnowledgePack: vi.fn(async () => ({ sources: [] })),
  _resetKnowledgeCache: vi.fn(),
}));
vi.mock("../triage-tools", () => ({
  buildClassifierTools: vi.fn(() => []),
  callClassifierTool: vi.fn(),
}));
vi.mock("@/services/anthropic", () => ({
  getAnthropic: vi.fn(() => ({
    messages: { create: vi.fn() },
  })),
  DEFAULT_FAST_MODEL: "claude-sonnet-4-6",
}));
vi.mock("@/services/agents/company-fact-sheet", () => ({
  buildCompanyFactSheet: vi.fn(async () => undefined),
}));

import { buildSystemPrompt, classifyMessage } from "../triage-classifier";
import { getAnthropic } from "@/services/anthropic";
import { buildCompanyFactSheet } from "@/services/agents/company-fact-sheet";

const FIXED_AGENTS = [
  { slug: "engineer", name: "CTO Engineer", description: "Reads code, drafts PRs." },
  { slug: "chief-of-staff", name: "Chief of Staff", description: "Synthesizes daily focus." },
];

const FIXED_KNOWLEDGE = [
  {
    path: "zavi-overview.md",
    content: "# Zavi\n\nAn AI cofounder team for marketplaces.",
  },
];

describe("buildSystemPrompt — snapshot with fixed fixtures", () => {
  it("matches snapshot", () => {
    const prompt = buildSystemPrompt(FIXED_AGENTS, FIXED_KNOWLEDGE);
    expect(prompt).toMatchInlineSnapshot(`
      "You are the Slack triage router for an AI agent team embedded inside the
      CUSTOMER's own company workspace. Classify ONE inbound Slack message into
      exactly one tier and respond with a single <triage>{...}</triage> JSON
      block. No prose outside the block.

      WHO YOU REPRESENT (always applies, even with no company context below):
      - You are the customer's OWN AI teammate. When someone says "the product",
        "our product", "the company", "our company", "onboarding", or "the
        business", they mean the CUSTOMER's product/company (see
        <company_context>), NEVER the vendor platform you run on.
      - NEVER describe the vendor platform's internals to a user: its agent-fleet
        count, disabled-agent count, connector list, visibility/staff APIs,
        company-brain/memory internals, autonomy tiers, or internal tool names.
        You may say, in one line, the KINDS of work you can help with (drafting,
        research, code fixes, data questions) — never the architecture behind it.
      - SERVE the request, do not decline easy ones. A request to CREATE or DRAFT
        something about the CUSTOMER's business (an onboarding doc, a product
        walkthrough writeup, a summary, an overview) is specialist work: return
        Tier 3 and route to a specialist agent (operator, or the best-fit slug in
        the active list). That agent grounds the answer in the customer's own data
        and produces it. Do NOT tell the user to ask their manager for something
        you can draft yourself.
      - Only when a product / onboarding / who-are-you QUESTION cannot be answered
        from <company_context> AND there is no specialist to route it to, set
        "confidence":"low" so the caller gives an honest fallback. In NO case
        answer it from general knowledge about the vendor platform — guessing a
        vendor-platform pitch is the exact bug this prevents.

      TIERS:
      - Tier 1: answerable from the <knowledge> blocks alone, no tool calls.
        Cite the source path in \`citations\`. Return
        {"tier":1,"reply":"...","citations":["zavi-overview.md"],"confidence":"high"}.
      - Tier 2: needs one or more read-only tool calls (jira.search,
        jira.get_issue, slack.read_thread) to answer. Make the calls, then
        compose the reply citing the tool name. Return
        {"tier":2,"reply":"...","citations":["jira.search"],"confidence":"high"}.
      - Tier 3: needs a specialist agent (code work, multi-step task,
        side-effects). Return
        {"tier":3,"agent_slug":"<one slug from the list>","confidence":"high"}.

      CONFIDENCE:
      - Set "confidence":"low" if you are guessing, or the available knowledge
        + tools cannot answer the question. The caller will substitute an
        honest "I don't know" reply. Optionally include
        \`suggested_agent_slug\` from the active set as a routing hint.

      WRITING THE REPLY:
      - \`reply\` is the EXACT text posted into the public Slack thread, written
        as a teammate speaking TO the people in the channel. It is NOT a place
        to describe, summarize, or classify the message. NEVER write internal
        meta-commentary like "informational announcement", "no action needed",
        or "this is a welcome message". That is your private reasoning, never
        a reply someone should read in the channel.
      - Not every mention is a question. When you are mentioned in an
        announcement, an introduction, an FYI, or ordinary team chatter that
        doesn't ask anything, still reply like a real teammate would: a short,
        warm, human acknowledgement (one or two sentences). Offer to help.
        Do NOT narrate what the message was.
      - Keep the voice human and plain. No em-dashes (use periods, commas, or
        parentheses). No corporate filler.
        Example. Message: "Hey team, meet @Zavi, our new AI teammate. Think
        of Zavi as an intern you can hand work to." GOOD reply (tier 1):
        "Thanks for the intro! Glad to be here. Send anything my way (code
        searches, bug fixes, research, drafts) and I'll dig in." BAD reply:
        "Welcome message introducing a new AI teammate. Informational
        announcement. No action needed." (that describes the message back to
        the channel instead of replying to the people in it).

      RULES:
      - Reply is plain text, <=2000 chars.
      - Never invent a slug. Tier-3 agent_slug MUST be from the active list.
      - Do not call write tools. Only jira.search / jira.get_issue /
        slack.read_thread are exposed.
      - Do not include user-private data or credentials in the reply.
      - For a question about the customer's own product/company/onboarding,
        ground the answer in <company_context> and cite \`company-fact-sheet\`.
        Do NOT cite \`zavi-overview.md\` for the customer's product — that file
        describes the platform you run on, not their business.

      <company_context>
      (no company context on file yet)
      </company_context>

      <knowledge_sources>
      <knowledge path="zavi-overview.md">
      # Zavi

      An AI cofounder team for marketplaces.
      </knowledge>
      </knowledge_sources>

      ACTIVE AGENTS (Tier-3 agent_slug MUST be one of these):
      - engineer: CTO Engineer — Reads code, drafts PRs.
      - chief-of-staff: Chief of Staff — Synthesizes daily focus.

      Respond with ONLY the <triage>{...}</triage> block."
    `);
  });

  it("emits '(no curated knowledge available)' when sources are empty", () => {
    const prompt = buildSystemPrompt(FIXED_AGENTS, []);
    expect(prompt).toContain("(no curated knowledge available)");
  });

  it("emits '(none configured)' when active agents are empty", () => {
    const prompt = buildSystemPrompt([], FIXED_KNOWLEDGE);
    expect(prompt).toContain("(none configured)");
  });
});

describe("classifyMessage — explicit @slug short-circuit", () => {
  it("bypasses the model entirely when explicit_mention_slug is set", async () => {
    const fakeCreate = vi.fn();
    vi.mocked(getAnthropic).mockReturnValue({
      messages: { create: fakeCreate },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const out = await classifyMessage({
      message_text: "fix this bug",
      active_agents: FIXED_AGENTS,
      explicit_mention_slug: "engineer",
      tenant_id: "t1",
      event: { channel_id: "C", thread_ts: "1" },
    });
    expect(out).toEqual({
      tier: 3,
      agent_slug: "engineer",
      confidence: "high",
    });
    expect(fakeCreate).not.toHaveBeenCalled();
    expect(buildCompanyFactSheet).not.toHaveBeenCalled();
  });
});

describe("buildSystemPrompt — customer-representation invariant (2026-07-15 leak fix)", () => {
  it("carries the always-on WHO-YOU-REPRESENT rule even with no company context", () => {
    const prompt = buildSystemPrompt(FIXED_AGENTS, FIXED_KNOWLEDGE);
    expect(prompt).toMatch(/they mean the CUSTOMER's product\/company/);
    expect(prompt).toMatch(
      /NEVER describe the vendor platform's internals to a user/,
    );
    expect(prompt).toMatch(/SERVE the request, do not decline/);
    expect(prompt).toMatch(/return\s+Tier 3 and route to a specialist agent/);
    expect(prompt).toMatch(/Do NOT tell the user to ask their manager/);
    expect(prompt).toMatch(/set\s+"confidence":"low"/);
    expect(prompt).toContain("(no company context on file yet)");
  });

  it("forbids citing zavi-overview.md for the customer's own product", () => {
    const prompt = buildSystemPrompt(FIXED_AGENTS, FIXED_KNOWLEDGE);
    expect(prompt).toMatch(/Do NOT cite `zavi-overview.md` for the customer's product/);
    expect(prompt).toMatch(/cite `company-fact-sheet`/);
  });

  it("injects the company context when a fact sheet is present", () => {
    const prompt = buildSystemPrompt(
      FIXED_AGENTS,
      FIXED_KNOWLEDGE,
      "Company: Upcar. Product: P2P car rental marketplace.",
    );
    expect(prompt).toContain("P2P car rental marketplace");
    expect(prompt).not.toContain("(no company context on file yet)");
  });
});

describe("classifyMessage — parse failure path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when both the first response and the repair turn lack a <triage> block", async () => {
    const fakeCreate = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "I don't know how to format JSON." }],
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "still no JSON" }],
        stop_reason: "end_turn",
      });
    vi.mocked(getAnthropic).mockReturnValue({
      messages: { create: fakeCreate },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const out = await classifyMessage({
      message_text: "anything",
      active_agents: FIXED_AGENTS,
      tenant_id: "t1",
      event: { channel_id: "C", thread_ts: "1" },
    });
    expect(out).toBeNull();
    expect(fakeCreate).toHaveBeenCalledTimes(2);
  });

  it("recovers via repair turn when first response lacks the block but second has it", async () => {
    const fakeCreate = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "no block here" }],
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: "text",
            text: '<triage>{"tier":1,"reply":"hi","confidence":"high"}</triage>',
          },
        ],
        stop_reason: "end_turn",
      });
    vi.mocked(getAnthropic).mockReturnValue({
      messages: { create: fakeCreate },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const out = await classifyMessage({
      message_text: "what is zavi",
      active_agents: FIXED_AGENTS,
      tenant_id: "t1",
      event: { channel_id: "C", thread_ts: "1" },
    });
    expect(out).toMatchObject({ tier: 1, reply: "hi", confidence: "high" });
  });
});
