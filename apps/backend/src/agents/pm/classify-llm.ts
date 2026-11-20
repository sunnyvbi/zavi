
import { getAnthropic, heliconePropertyHeaders } from "@/services/anthropic";

const TIEBREAK_MODEL = "claude-haiku-4-5-20251001";
const TIEBREAK_TIMEOUT_MS = 1500;

const SYSTEM = [
  "You route a product-manager agent's chat turn into exactly one mode.",
  "Reply with ONLY one lowercase word: delivery OR strategy_memo. No punctuation, no explanation.",
  "",
  "DECISIVE RULE (apply FIRST): if the operator explicitly asks for a RICE-ranked",
  "backlog, a ranked shortlist of fixes, 'what should we ship (next/this week)', or a",
  "prioritized list of items, answer `delivery` — even when the SAME message is wrapped",
  "in heavy strategic framing ('give me your read', 'untangle this', 'before I commit the",
  "team', 'what should we NOT spend the week on', 'I have a nagging feeling'). A concrete",
  "ranked-backlog/what-to-ship request OVERRIDES the surrounding judgment language. The",
  "strategic framing is context for the prioritization, not a request for a memo.",
  "",
  "delivery = the operator wants a concrete prioritized ARTIFACT: a RICE-ranked backlog,",
  "  'what should we ship next', a bottleneck diagnosis with a ranked shortlist of fixes.",
  "  Even if it mentions growth/retention/churn, if the ask is 'rank what to ship', it is delivery.",
  "",
  "strategy_memo = the operator wants JUDGMENT on a strategic DECISION or TRADEOFF and is",
  "  NOT asking for a ranked backlog/shortlist of items to ship:",
  "  pricing/monetization, geographic rollout, ICP/positioning, 'X vs Y — what's the call',",
  "  'how hard do we clamp down on fraud vs keep supply', 'should we charge at launch'.",
  "  The deliverable is a recommended direction + reasoning + reversal triggers, NOT a backlog.",
].join("\n");

export async function pmModeTiebreak(
  userText: string,
  tags: { tenantId?: string | null; agentSlug?: string | null; runId?: string | null },
): Promise<"delivery" | "strategy_memo"> {
  const client = getAnthropic();
  const call = client.messages.create(
    {
      model: TIEBREAK_MODEL,
      max_tokens: 8,
      temperature: 0,
      system: SYSTEM,
      messages: [{ role: "user", content: userText.slice(0, 4000) }],
    },
    { headers: heliconePropertyHeaders(tags) },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`pmModeTiebreak timeout after ${TIEBREAK_TIMEOUT_MS}ms`)),
      TIEBREAK_TIMEOUT_MS,
    );
  });

  try {
    const res = await Promise.race([call, timeout]);
    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
      .toLowerCase();
    if (/strategy_memo/.test(text)) return "strategy_memo";
    if (/delivery/.test(text)) return "delivery";
    throw new Error(`pmModeTiebreak unparseable output: ${text.slice(0, 40)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
