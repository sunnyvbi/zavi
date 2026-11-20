
import type { ToolCallTrace } from "@/services/tools/types";
import { unescapeJsonPreview } from "@/services/tools/types";

export const CAP_VALIDATOR_AGENTS: ReadonlySet<string> = new Set([
  "performance-marketer",
]);

const ALLOWLISTED_CAP_AMOUNTS: ReadonlySet<string> = new Set(["500"]);

const POLICY_KEYWORD =
  /\b(?:cap|capped|caps|ceiling|ceilings|limit|limited|limits|policy|standing|hard\s+rule|requires?\s+approval|must\s+be\s+approved|needs?\s+approval|approval\s+(?:above|over|threshold)|max(?:imum)?\s+(?:weekly|monthly|daily)?\s*(?:spend|budget))\b/i;

const DOLLAR_TOKEN = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/g;

const POLICY_KEYWORD_ATOM = POLICY_KEYWORD.source.replace(/^\\b/, "").replace(/\\b$/, "");

const DOLLAR_ATOM = String.raw`\$\s?\d[\d,]*(?:\.\d+)?`;

const CONNECTOR = String.raw`(?:\s*:\s*|\s+(?:of|is|are|at|to|above|over|per|the|a|an)\b)*\s*`;

const CAP_BOUND_AMOUNT = new RegExp(
  `${DOLLAR_ATOM}(?:\\s*/\\s*\\w+)?(?:\\s+\\w+){0,2}?\\s+\\b(?:${POLICY_KEYWORD_ATOM})\\b` +
    "|" +
    `\\b(?:${POLICY_KEYWORD_ATOM})\\b${CONNECTOR}${DOLLAR_ATOM}`,
  "gi",
);

export type CapGroundingFlags = {
  has_cap_claim: boolean;
  ungrounded_amounts: string[];
  candidate_amounts: string[];
};

export type CapVerificationResult = {
  hedged: boolean;
  text: string;
  flags: CapGroundingFlags;
};

function normalizeAmount(raw: string): string {
  const cleaned = raw.replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return cleaned;
  return Number.isInteger(n) ? String(n) : String(n);
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|(?<=:)\s+(?!\$)|\n+|\s*\|\s*/);
}

export function amountInToolOutputs(
  amount: string,
  toolCalls: readonly ToolCallTrace[],
  opts?: { includeInputs?: boolean },
): boolean {
  const a = amount.replace(/[.,]/g, "\\$&");
  const moneyRe = new RegExp(
    `\\$\\s?${a}\\b` +
      `|\\b${a}\\.\\d{1,2}\\b` +
      `|(?:usd|budget|spend|amount|cap|limit|ceiling)[\\"'\\s:_a-z]*${a}\\b`,
    "i",
  );
  return toolCalls.some((t) => {
    if (typeof t?.name !== "string") return false;
    if (t.name.startsWith("memory__")) return false;
    const out = unescapeJsonPreview(
      typeof t.output_preview === "string" ? t.output_preview : "",
    );
    if (moneyRe.test(out)) return true;
    if (!opts?.includeInputs) return false;
    const inp = unescapeJsonPreview(
      typeof t.input_preview === "string" ? t.input_preview : "",
    );
    return moneyRe.test(inp);
  });
}

function buildCapHedgeBanner(amounts: string[]): string {
  const list = amounts.map((a) => `$${a}`).join(", ");
  return [
    "> ⚠️ **Unverified cap/policy** — this reply states a spending cap or policy (" +
      list +
      ") that no tool result from this run supports.",
    "> Treat that figure as **unconfirmed** — it may be a misremembered or invented constraint. Verify the actual limit before acting on it.",
    "",
    "",
  ].join("\n");
}

export function verifyCapGrounding(args: {
  reply: string;
  toolCalls?: readonly ToolCallTrace[];
}): CapVerificationResult {
  const reply = typeof args.reply === "string" ? args.reply : "";
  const toolCalls = args.toolCalls ?? [];
  const candidateAmounts: string[] = [];
  const ungrounded: string[] = [];

  for (const sentence of splitSentences(reply)) {
    if (!POLICY_KEYWORD.test(sentence)) continue;
    const tokens = sentence.match(DOLLAR_TOKEN);
    if (!tokens) continue;
    const boundTokens = sentence.match(CAP_BOUND_AMOUNT);
    const scanned =
      boundTokens && boundTokens.length > 0
        ? boundTokens.flatMap((t) => t.match(DOLLAR_TOKEN) ?? [])
        : tokens;
    const amounts = scanned.map(normalizeAmount);
    candidateAmounts.push(...amounts);
    if (amounts.some((a) => ALLOWLISTED_CAP_AMOUNTS.has(a))) continue;
    for (const amount of amounts) {
      if (amountInToolOutputs(amount, toolCalls, { includeInputs: true }))
        continue;
      ungrounded.push(amount);
    }
  }

  const flags: CapGroundingFlags = {
    has_cap_claim: candidateAmounts.length > 0,
    ungrounded_amounts: Array.from(new Set(ungrounded)),
    candidate_amounts: Array.from(new Set(candidateAmounts)),
  };

  if (flags.ungrounded_amounts.length === 0) {
    return { hedged: false, text: reply, flags };
  }
  return {
    hedged: true,
    text: reply.replace(/\s+$/, "") + "\n\n" + buildCapHedgeBanner(flags.ungrounded_amounts).replace(/\n+$/, "") + "\n",
    flags,
  };
}
