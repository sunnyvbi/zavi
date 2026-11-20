
import { GROWTH_PROBLEMS } from "../../growth/goal-owner";
import type { AgentAdapter, SimApplied } from "./types";

export const VERIFIER_PROMPT = `You classify work items for a growth simulator. Each item is one piece of work an AI head of growth handed to a specialist (the specialist is in parentheses). Decide which ONE growth problem the work, if done, would mainly fix.

Problems:
- traffic: too few visitors or leads reach the business (acquisition, outreach, referrals, content that attracts people)
- conversion: visitors or leads don't sign up, book or buy (landing page, checkout, signup flow, form friction)
- activation: people who signed up don't start using the product
- retention: users or customers don't come back, or churn
- offer: the price, promotion or positioning is wrong
- tracking: numbers are wrong, missing or unattributed (measurement, attribution, counting)
- channel: one specific existing marketing channel or campaign underperforms (fix, pause or tune that channel)
- other: none of the above
- ambiguous: the work targets two or more of these about equally, or is too vague to tell

Judge what the work would change, not which words it uses. When unsure, answer ambiguous.
Output ONLY one line per item, exactly "n: label", nothing else.

Items:
`;

export type Classifier = (prompt: string) => Promise<string>;

export type VerifyItem = { agent: string; intent: string };

const LABELS = new Set<string>([...GROWTH_PROBLEMS, "ambiguous"]);

export function verifyPrompt(items: VerifyItem[]): string {
  return VERIFIER_PROMPT + items.map((it, i) => `${i + 1}. (${it.agent}) ${it.intent.replace(/\s+/g, " ").trim()}`).join("\n") + "\n";
}

export function parseLabels(text: string, n: number): string[] {
  const out: string[] = Array.from({ length: n }, () => "ambiguous");
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s*[:.)-]\s*([a-z]+)/i.exec(line);
    if (!m) continue;
    const i = Number(m[1]) - 1;
    const label = m[2].toLowerCase();
    if (i >= 0 && i < n && LABELS.has(label)) out[i] = label;
  }
  return out;
}

export type Verdict = "match" | "mismatch" | "ambiguous";

export function combinedLabel(a: string, b: string): string | null {
  if (a === b) return a === "ambiguous" ? null : a;
  if (a === "ambiguous") return b;
  if (b === "ambiguous") return a;
  return null;
}

export function combine(declared: string, a: string, b: string): Verdict {
  const label = combinedLabel(a, b);
  if (label === null) return "ambiguous";
  return label === declared ? "match" : "mismatch";
}

export async function classifyBoth(items: VerifyItem[], gpt: Classifier, grok: Classifier): Promise<Array<[string, string]>> {
  if (items.length === 0) return [];
  const prompt = verifyPrompt(items);
  const [g, k] = await Promise.all([gpt(prompt), grok(prompt)]);
  const gl = parseLabels(g, items.length);
  const kl = parseLabels(k, items.length);
  return items.map((_, i) => [gl[i], kl[i]]);
}

export function withVerifier(adapter: AgentAdapter, gpt: Classifier, grok: Classifier): AgentAdapter {
  return {
    name: `${adapter.name}+verified`,
    dailyCheck: (s, state) => adapter.dailyCheck(s, state),
    async review(view, state) {
      const out = await adapter.review(view, state);
      const moves = out.applied.moves;
      const labels = await classifyBoth(
        moves.map((m) => ({ agent: m.target_agent, intent: m.what })),
        gpt,
        grok,
      );
      const verified: SimApplied["moves"] = moves.map((m, i) => {
        const declared = (m.problem ?? "unspecified").toLowerCase();
        const verdict = combine(declared, labels[i][0], labels[i][1]);
        const read = combinedLabel(labels[i][0], labels[i][1]);
        return { ...m, problem: verdict === "mismatch" && read ? read : declared, declared, verdict, verifiers: labels[i] };
      });
      return { ...out, applied: { ...out.applied, moves: verified } };
    },
  };
}
