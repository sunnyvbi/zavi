
import { z } from "zod";
import type { Anthropic } from "@anthropic-ai/sdk";
import { getAnthropic, DEFAULT_FAST_MODEL } from "@/services/anthropic";
import { buildCompanyFactSheet } from "@/services/agents/company-fact-sheet";
import { buildInboxAddressBlock } from "@/services/agents/agent-inbox-context";
import { loadKnowledgePack } from "./knowledge";
import {
  buildClassifierTools,
  callClassifierTool,
  type TriageEventContext,
} from "./triage-tools";

export type ActiveAgent = { slug: string; name: string; description: string };

export type TriageInput = {
  message_text: string;
  active_agents: ActiveAgent[];
  explicit_mention_slug?: string;
  tenant_id: string;
  event: TriageEventContext;
  source_team_id?: string;
  thread_excerpt?: string;
};

const TriageSchema = z
  .object({
    tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    reply: z.string().max(2000).optional(),
    agent_slug: z.string().max(64).optional(),
    suggested_agent_slug: z.string().max(64).optional(),
    citations: z.array(z.string().max(200)).max(10).optional(),
    confidence: z.union([z.literal("high"), z.literal("low")]).default("high"),
  })
  .refine(
    (o) => {
      if (o.tier === 3) return !!o.agent_slug;
      return o.confidence === "low" || !!o.reply;
    },
    {
      message:
        "tier 3 requires agent_slug; tier 1/2 require reply unless confidence=low",
    },
  );

export type TriageResult = z.infer<typeof TriageSchema>;

const BLOCK_RE = /<triage>([\s\S]*?)<\/triage>/;

const MAX_TOOL_CALLS = 5;
const WALL_CLOCK_MS = 15_000;
const MAX_KNOWLEDGE_CHARS = 8_000;

export function buildSystemPrompt(
  agents: ActiveAgent[],
  knowledge: Array<{ path: string; content: string }>,
  companyContext?: string,
): string {
  const agentList =
    agents.length > 0
      ? agents.map((a) => `- ${a.slug}: ${a.name} — ${a.description}`).join("\n")
      : "(none configured)";

  const knowledgeBlocks = knowledge
    .map(
      (k) =>
        `<knowledge path="${k.path}">\n${k.content.slice(0, MAX_KNOWLEDGE_CHARS)}\n</knowledge>`,
    )
    .join("\n\n");

  const companyBlock = companyContext
    ? companyContext.slice(0, MAX_KNOWLEDGE_CHARS)
    : "(no company context on file yet)";

  return [
    "You are the Slack triage router for an AI agent team embedded inside the",
    "CUSTOMER's own company workspace. Classify ONE inbound Slack message into",
    "exactly one tier and respond with a single <triage>{...}</triage> JSON",
    "block. No prose outside the block.",
    "",
    "WHO YOU REPRESENT (always applies, even with no company context below):",
    "- You are the customer's OWN AI teammate. When someone says \"the product\",",
    "  \"our product\", \"the company\", \"our company\", \"onboarding\", or \"the",
    "  business\", they mean the CUSTOMER's product/company (see",
    "  <company_context>), NEVER the vendor platform you run on.",
    "- NEVER describe the vendor platform's internals to a user: its agent-fleet",
    "  count, disabled-agent count, connector list, visibility/staff APIs,",
    "  company-brain/memory internals, autonomy tiers, or internal tool names.",
    "  You may say, in one line, the KINDS of work you can help with (drafting,",
    "  research, code fixes, data questions) — never the architecture behind it.",
    "- SERVE the request, do not decline easy ones. A request to CREATE or DRAFT",
    "  something about the CUSTOMER's business (an onboarding doc, a product",
    "  walkthrough writeup, a summary, an overview) is specialist work: return",
    "  Tier 3 and route to a specialist agent (operator, or the best-fit slug in",
    "  the active list). That agent grounds the answer in the customer's own data",
    "  and produces it. Do NOT tell the user to ask their manager for something",
    "  you can draft yourself.",
    "- Only when a product / onboarding / who-are-you QUESTION cannot be answered",
    "  from <company_context> AND there is no specialist to route it to, set",
    '  "confidence":"low" so the caller gives an honest fallback. In NO case',
    "  answer it from general knowledge about the vendor platform — guessing a",
    "  vendor-platform pitch is the exact bug this prevents.",
    "",
    "TIERS:",
    '- Tier 1: answerable from the <knowledge> blocks alone, no tool calls.',
    '  Cite the source path in `citations`. Return',
    '  {"tier":1,"reply":"...","citations":["zavi-overview.md"],"confidence":"high"}.',
    "- Tier 2: needs one or more read-only tool calls (jira.search,",
    "  jira.get_issue, slack.read_thread) to answer. Make the calls, then",
    "  compose the reply citing the tool name. Return",
    '  {"tier":2,"reply":"...","citations":["jira.search"],"confidence":"high"}.',
    "- Tier 3: needs a specialist agent (code work, multi-step task,",
    "  side-effects). Return",
    '  {"tier":3,"agent_slug":"<one slug from the list>","confidence":"high"}.',
    "",
    "CONFIDENCE:",
    '- Set "confidence":"low" if you are guessing, or the available knowledge',
    "  + tools cannot answer the question. The caller will substitute an",
    '  honest "I don\'t know" reply. Optionally include',
    "  `suggested_agent_slug` from the active set as a routing hint.",
    "",
    "WRITING THE REPLY:",
    "- `reply` is the EXACT text posted into the public Slack thread, written",
    "  as a teammate speaking TO the people in the channel. It is NOT a place",
    "  to describe, summarize, or classify the message. NEVER write internal",
    '  meta-commentary like "informational announcement", "no action needed",',
    '  or "this is a welcome message". That is your private reasoning, never',
    "  a reply someone should read in the channel.",
    "- Not every mention is a question. When you are mentioned in an",
    "  announcement, an introduction, an FYI, or ordinary team chatter that",
    "  doesn't ask anything, still reply like a real teammate would: a short,",
    "  warm, human acknowledgement (one or two sentences). Offer to help.",
    "  Do NOT narrate what the message was.",
    "- Keep the voice human and plain. No em-dashes (use periods, commas, or",
    "  parentheses). No corporate filler.",
    '  Example. Message: "Hey team, meet @Zavi, our new AI teammate. Think',
    '  of Zavi as an intern you can hand work to." GOOD reply (tier 1):',
    '  "Thanks for the intro! Glad to be here. Send anything my way (code',
    '  searches, bug fixes, research, drafts) and I\'ll dig in." BAD reply:',
    '  "Welcome message introducing a new AI teammate. Informational',
    '  announcement. No action needed." (that describes the message back to',
    "  the channel instead of replying to the people in it).",
    "",
    "RULES:",
    "- Reply is plain text, <=2000 chars.",
    "- Never invent a slug. Tier-3 agent_slug MUST be from the active list.",
    "- Do not call write tools. Only jira.search / jira.get_issue /",
    "  slack.read_thread are exposed.",
    "- Do not include user-private data or credentials in the reply.",
    "- For a question about the customer's own product/company/onboarding,",
    "  ground the answer in <company_context> and cite `company-fact-sheet`.",
    "  Do NOT cite `zavi-overview.md` for the customer's product — that file",
    "  describes the platform you run on, not their business.",
    "",
    "<company_context>",
    companyBlock,
    "</company_context>",
    "",
    "<knowledge_sources>",
    knowledgeBlocks || "(no curated knowledge available)",
    "</knowledge_sources>",
    "",
    "ACTIVE AGENTS (Tier-3 agent_slug MUST be one of these):",
    agentList,
    "",
    "Respond with ONLY the <triage>{...}</triage> block.",
  ].join("\n");
}

const COMPANY_CONTEXT_TIMEOUT_MS = 1_500;

async function loadCompanyContextSoft(
  tenant_id: string,
): Promise<string | undefined> {
  try {
    return await Promise.race([
      (async () => {
        const [sheet, inbox] = await Promise.all([
          buildCompanyFactSheet(tenant_id),
          buildInboxAddressBlock(tenant_id),
        ]);
        const parts = [inbox, sheet].filter(
          (p): p is string => typeof p === "string" && p.length > 0,
        );
        return parts.length > 0 ? parts.join("\n\n") : undefined;
      })(),
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), COMPANY_CONTEXT_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    console.warn(
      `[triage-classifier] company_context_unavailable: ${(e as Error).message}`,
    );
    return undefined;
  }
}

export async function classifyMessage(
  input: TriageInput,
): Promise<TriageResult | null> {
  if (input.explicit_mention_slug) {
    return {
      tier: 3,
      agent_slug: input.explicit_mention_slug,
      confidence: "high",
    };
  }

  const anthropic = getAnthropic();
  const [pack, companyContext] = await Promise.all([
    loadKnowledgePack(),
    loadCompanyContextSoft(input.tenant_id),
  ]);
  const tools = buildClassifierTools();
  const system = buildSystemPrompt(
    input.active_agents,
    pack.sources,
    companyContext,
  );

  const userContent = input.thread_excerpt
    ? `${input.thread_excerpt}\n\n---\nCurrent message:\n${input.message_text}`
    : input.message_text;
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userContent },
  ];

  const startedAt = Date.now();
  let toolCalls = 0;
  let raw = "";

  try {
    while (toolCalls < MAX_TOOL_CALLS) {
      const remaining = WALL_CLOCK_MS - (Date.now() - startedAt);
      if (remaining <= 0) break;

      const resp = await anthropic.messages.create(
        {
          model: DEFAULT_FAST_MODEL,
          max_tokens: 800,
          temperature: 0,
          system,
          tools,
          messages,
        },
        { signal: AbortSignal.timeout(remaining) },
      );

      if (resp.stop_reason !== "tool_use") {
        raw = resp.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("")
          .trim();
        break;
      }

      messages.push({ role: "assistant", content: resp.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of resp.content) {
        if (block.type !== "tool_use") continue;
        toolCalls += 1;
        if (toolCalls > MAX_TOOL_CALLS) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify({ error: "tool_budget_exceeded" }),
            is_error: true,
          });
          continue;
        }
        const exec = await callClassifierTool(
          {
            tenant_id: input.tenant_id,
            run_id: "",
            slack_target_team_id: input.source_team_id,
          },
          input.event,
          block.name,
          block.input,
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(exec.shaped),
          is_error: exec.is_error,
        });
      }

      messages.push({ role: "user", content: toolResults });
    }
  } catch (e) {
    console.warn(`[triage-classifier] model call failed: ${(e as Error).message}`);
    return null;
  }

  const first = parseTriage(raw);
  if (first) return first;

  messages.push({ role: "assistant", content: raw });
  messages.push({
    role: "user",
    content:
      "Reply with ONLY a <triage>{...}</triage> JSON block. No prose, no markdown.",
  });
  try {
    const repair = await anthropic.messages.create(
      {
        model: DEFAULT_FAST_MODEL,
        max_tokens: 400,
        temperature: 0,
        system,
        messages,
      },
      { signal: AbortSignal.timeout(10_000) },
    );
    const repaired = repair.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return parseTriage(repaired);
  } catch (e) {
    console.warn(`[triage-classifier] repair turn failed: ${(e as Error).message}`);
    return null;
  }
}

function parseTriage(raw: string): TriageResult | null {
  const m = raw.match(BLOCK_RE);
  if (!m) {
    console.warn("[triage-classifier] no <triage> block in response");
    return null;
  }
  try {
    return TriageSchema.parse(JSON.parse(m[1]));
  } catch (e) {
    console.warn(`[triage-classifier] parse failed: ${(e as Error).message}`);
    return null;
  }
}
