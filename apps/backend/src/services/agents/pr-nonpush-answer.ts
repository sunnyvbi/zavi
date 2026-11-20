
import { getAnthropic, heliconePropertyHeaders } from "@/services/anthropic";
import { serviceClient } from "@/services/supabase";
import {
  getPrImpl,
  resolveInstallationId,
} from "@/services/mcp/internal/github";
import type { OpenEngineerPr } from "./chat-pr-followup";

const STATUS_PROVENANCE_MARKERS: RegExp[] = [
  /\b(is|are|was|were)\s+(this|it|that|the\s+(pr|fix|issue|bug|change))\b[\s\S]{0,40}?\b(fixed|resolved|done|merged|shipped|complete|completed|working|live|deployed|closed|open)\b/i,
  /\bdid\s+(it|this|that|the\s+pr)\b[\s\S]{0,30}?\b(merge|ship|land|get\s+fixed|go\s+out|deploy)\b/i,
  /\bhas\s+(this|it|that|the\s+pr)\b[\s\S]{0,30}?\b(been\s+)?(fixed|merged|shipped|resolved|closed|done|deployed)\b/i,
  /\b(another|other|some\s+other|a\s+different|different)\s+agent\b/i,
  /\bwho\s+(fixed|did|shipped|merged|handled|worked\s+on)\b/i,
  /\balready\s+(fixed|done|handled|merged|shipped|resolved|open|created)\b/i,
  /\bwhat('?s|\s+is)\s+the\s+(status|pr|pull\s*request|link)\b/i,
  /\bwhich\s+prs?\b[\s\S]{0,20}?\b(open|are\s+(there|open))\b/i,
  /\bis\s+ci\s+(green|passing)\b/i,
  /\bstatus\s+(of|on)\s+(the\s+)?prs?\b/i,
];

export function isStatusOrProvenanceQuestion(text: string): boolean {
  const t = text.replace(/<@[A-Z0-9]+>/gi, "").trim();
  if (t.length === 0) return false;
  return STATUS_PROVENANCE_MARKERS.some((re) => re.test(t));
}

export type PrLiveState = {
  pr_number: number;
  pr_repo: string;
  pr_url: string;
  state: "open" | "closed" | "unknown";
  merged: boolean;
};

export type NonPushAnswerDeps = {
  resolveInstallationId?: (tenant_id: string) => Promise<number>;
  getPr?: (
    tenant_id: string,
    installation_id: number,
    args: { owner: string; repo: string; pull_number: number },
  ) => Promise<{ state: string; merged: boolean }>;
  composeAnswer?: (
    question: string,
    projected: PrLiveState[],
    tags: { tenant_id: string },
  ) => Promise<string>;
};

export async function projectPrLiveState(
  tenant_id: string,
  prs: OpenEngineerPr[],
  deps: NonPushAnswerDeps = {},
): Promise<PrLiveState[]> {
  const resolveId = deps.resolveInstallationId ?? resolveInstallationId;
  const getPr = deps.getPr ?? getPrImpl;

  let installation_id: number | null = null;
  try {
    installation_id = await resolveId(tenant_id);
  } catch {
    installation_id = null;
  }

  const out: PrLiveState[] = [];
  for (const pr of prs) {
    const slash = pr.pr_repo.indexOf("/");
    const owner = slash > 0 ? pr.pr_repo.slice(0, slash) : "";
    const repo = slash > 0 ? pr.pr_repo.slice(slash + 1) : pr.pr_repo;
    let state: PrLiveState["state"] = "unknown";
    let merged = false;
    if (installation_id != null && owner && repo) {
      try {
        const live = await getPr(tenant_id, installation_id, {
          owner,
          repo,
          pull_number: pr.pr_number,
        });
        state = live.state === "open" ? "open" : "closed";
        merged = live.merged === true;
      } catch {
        state = "unknown";
        merged = false;
      }
    }
    out.push({
      pr_number: pr.pr_number,
      pr_repo: pr.pr_repo,
      pr_url: pr.pr_url,
      state,
      merged,
    });
  }
  return out;
}

export function buildLiveStateAnswer(projected: PrLiveState[]): string {
  if (projected.length === 0) {
    return "I don't see an open PR from me on this thread yet. Tell me what to build or fix and I'll open one.";
  }
  const fmt = (p: PrLiveState) => `#${p.pr_number} (${p.pr_repo})`;
  const merged = projected.filter((p) => p.merged);
  const open = projected.filter((p) => p.state === "open" && !p.merged);
  const closed = projected.filter((p) => p.state === "closed" && !p.merged);
  const unknown = projected.filter((p) => p.state === "unknown");

  const parts: string[] = [];
  parts.push("These are mine, not another agent's.");
  if (open.length) parts.push(`Still open: ${open.map(fmt).join(", ")} (${open.map((p) => p.pr_url).join(" ")}).`);
  if (merged.length) parts.push(`Already merged: ${merged.map(fmt).join(", ")}.`);
  if (closed.length) parts.push(`Closed unmerged: ${closed.map(fmt).join(", ")}.`);
  if (unknown.length) parts.push(`Couldn't confirm live state for ${unknown.map(fmt).join(", ")} — check GitHub.`);
  return parts.join(" ");
}

const COMPOSE_MODEL = "claude-haiku-4-5-20251001";
const COMPOSE_TIMEOUT_MS = 4000;
const COMPOSE_SYSTEM = [
  "You are Zavi's engineer agent answering the operator in a Slack thread.",
  "You are given the operator's question and a JSON array of the pull requests",
  "YOU (this same engineer agent) opened earlier on THIS thread, each with its",
  "LIVE state from GitHub. Answer the question in at most 2 short sentences,",
  "plain, builder-to-builder, no markdown headers, no preamble.",
  "",
  "HARD RULES:",
  "- Ground EVERY claim in the JSON. A PR with merged:true is MERGED; state:'open'",
  "  is open; state:'unknown' means you could not confirm — say so, never guess.",
  "- If the operator asks whether another/other agent fixed it, make clear these",
  "  PRs are YOURS (this engineer), not another agent's.",
  "- Never invent PR numbers, titles, or state not present in the JSON.",
  "- You open PRs but do NOT merge them into the operator's repo; don't claim to.",
].join("\n");

export async function composeStateAnswerLLM(
  question: string,
  projected: PrLiveState[],
  tags: { tenant_id: string },
): Promise<string> {
  const client = getAnthropic();
  const userContent = [
    `Operator question: ${question.slice(0, 2000)}`,
    "",
    "PRs (live state):",
    JSON.stringify(
      projected.map((p) => ({
        pr: p.pr_number,
        repo: p.pr_repo,
        url: p.pr_url,
        state: p.state,
        merged: p.merged,
      })),
    ),
  ].join("\n");

  const call = client.messages.create(
    {
      model: COMPOSE_MODEL,
      max_tokens: 220,
      temperature: 0,
      system: COMPOSE_SYSTEM,
      messages: [{ role: "user", content: userContent }],
    },
    { headers: heliconePropertyHeaders({ tenantId: tags.tenant_id, agentSlug: "engineer" }) },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`composeStateAnswerLLM timeout after ${COMPOSE_TIMEOUT_MS}ms`)),
      COMPOSE_TIMEOUT_MS,
    );
  });
  try {
    const res = await Promise.race([call, timeout]);
    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
      .trim();
    if (!text) throw new Error("composeStateAnswerLLM empty output");
    return text;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type NonPushAnswerArgs = {
  tenant_id: string;
  text: string;
  prs: OpenEngineerPr[];
};

export async function answerNonPushFollowup(
  args: NonPushAnswerArgs,
  deps: NonPushAnswerDeps = {},
): Promise<string | null> {
  if (!isStatusOrProvenanceQuestion(args.text)) return null;

  const projected = await projectPrLiveState(args.tenant_id, args.prs, deps);
  const compose = deps.composeAnswer ?? composeStateAnswerLLM;
  try {
    return await compose(args.text, projected, { tenant_id: args.tenant_id });
  } catch {
    return buildLiveStateAnswer(projected);
  }
}
