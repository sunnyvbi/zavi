
import { getAnthropic, heliconePropertyHeaders } from "@/services/anthropic";

const APPROVAL_INTENT =
  /\b(approve|approved|reject|rejected|decline|declined|unpause|un-?pause|resume|re-?enable|enable|pause|disable|go ahead|do it|ship it|send it|confirm|approve all|reject all|set (the )?budget|change (the )?budget|spend|\$\s?\d)/i;

export function looksLikeApprovalIntent(text: string): boolean {
  return APPROVAL_INTENT.test(text || "");
}

export type ApprovalCandidate = {
  index: number;
  decision_class: string | null;
  summary: string;
};

const NARROW_MODEL = "claude-haiku-4-5-20251001";
const NARROW_TIMEOUT_MS = 1500;

export async function narrowApprovalTargets(
  text: string,
  candidates: ApprovalCandidate[],
  tags: { tenantId?: string | null; runId?: string | null } = {},
): Promise<number[] | null> {
  if (candidates.length <= 1) return null;
  const list = candidates
    .map((c) => `${c.index}. [${c.decision_class ?? "decision"}] ${c.summary}`)
    .join("\n");
  const system = [
    "You map ONE operator Slack reply to which pending approval(s) it refers to.",
    "You are given a numbered list of pending approvals. Reply with ONLY a JSON",
    'object: {"targets":[<indices>]} using ONLY numbers from the list, OR',
    '{"targets":"all"} if the reply refers to all of them or you cannot tell.',
    "No prose, no markdown, no explanation. Prefer \"all\" over guessing wrong.",
  ].join("\n");
  const client = getAnthropic();
  const call = client.messages.create(
    {
      model: NARROW_MODEL,
      max_tokens: 64,
      temperature: 0,
      system,
      messages: [{ role: "user", content: `Pending approvals:\n${list}\n\nReply: ${text}` }],
    },
    { headers: heliconePropertyHeaders({ tenantId: tags.tenantId ?? undefined, runId: tags.runId ?? undefined, agentSlug: "slack-approval-nl" }) },
  );
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("narrow_timeout")), NARROW_TIMEOUT_MS),
  );
  const resp = (await Promise.race([call, timeout])) as Awaited<typeof call>;
  const block = resp.content?.[0];
  const raw = block && block.type === "text" ? block.text.trim() : "";
  const parsed = JSON.parse(raw) as { targets?: number[] | string };
  if (parsed.targets === "all" || !Array.isArray(parsed.targets)) return null;
  const valid = new Set(candidates.map((c) => c.index));
  const picked = parsed.targets.filter((n) => Number.isInteger(n) && valid.has(n));
  return picked.length > 0 ? picked : null;
}
