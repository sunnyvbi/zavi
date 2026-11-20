
import type { AgentContext } from "@/services/agents/types";

export const INCOMPLETE_TITLE_PREFIX = "[incomplete] ";
const TITLE_MAX = 120;
const BODY_MAX = 8000;

export function isStepCapFallback(
  ctx: Pick<AgentContext, "engineer_cost_v2"> & { agent: { slug: string } },
  envelope: unknown,
  payload?: unknown,
): boolean {
  if (ctx.agent.slug !== "engineer" || ctx.engineer_cost_v2 !== true) return false;
  const stage =
    payload && typeof payload === "object" ? (payload as { stage?: unknown }).stage : undefined;
  if (typeof stage === "string" && stage.length > 0) return false;
  return (
    !!envelope &&
    typeof envelope === "object" &&
    (envelope as { parse_fallback_kind?: unknown }).parse_fallback_kind === "tool_iter_cap_fallback"
  );
}

function oneLine(s: string, max: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function buildStepCapProposal(args: {
  fallback: unknown;
  repo: string;
  taskText: string;
}): Record<string, unknown> {
  const lastNotes =
    args.fallback &&
    typeof args.fallback === "object" &&
    typeof (args.fallback as { rendered_markdown?: unknown }).rendered_markdown === "string"
      ? (args.fallback as { rendered_markdown: string }).rendered_markdown.trim()
      : "";
  const task = args.taskText.trim();
  const titleCore = task ? oneLine(task, TITLE_MAX - INCOMPLETE_TITLE_PREFIX.length) : "Engineer changes";
  const body = [
    "## Incomplete: the step budget ran out",
    "The engineer used its whole step budget before it finished, so it never handed back a finished proposal. " +
      "This PR holds exactly what it had changed in the worktree at that point. Review it as partial work.",
    "",
    "## What is done",
    "The changes in this diff.",
    "",
    "## What is left",
    "Not listed: the run stopped before the agent could say. Compare the diff with the task:",
    "",
    task ? `> ${oneLine(task, 1500)}` : "> (task text not available)",
    ...(lastNotes ? ["", "## Last notes from the agent", lastNotes.slice(0, 3000)] : []),
  ].join("\n");
  return {
    repo: args.repo,
    base_branch: "main",
    title: titleCore,
    body: body.slice(0, BODY_MAX),
    rendered_markdown: lastNotes ? lastNotes.slice(0, 3000) : "I reached my step budget before finishing.",
    risk_class: "medium",
    incomplete: true,
    remaining: [],
  };
}

export function markIncompleteProposal(m: Record<string, unknown>): void {
  if (m.incomplete !== true) return;
  const title = typeof m.title === "string" ? m.title.trim() : "";
  if (!title.toLowerCase().startsWith(INCOMPLETE_TITLE_PREFIX.trim().toLowerCase())) {
    const room = TITLE_MAX - INCOMPLETE_TITLE_PREFIX.length;
    m.title = INCOMPLETE_TITLE_PREFIX + (title.length > room ? title.slice(0, room).trimEnd() : title || "Engineer changes");
  }
  const body = typeof m.body === "string" ? m.body : "";
  if (/^## (Incomplete|What is left)\b/m.test(body)) return;
  const remaining = Array.isArray(m.remaining)
    ? (m.remaining as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  const section = [
    "## Incomplete",
    "The engineer handed this back before finishing (it reached its step budget). Review it as partial work.",
    "",
    "### What is left",
    ...(remaining.length > 0 ? remaining.map((r) => `- ${r}`) : ["- Not listed by the agent."]),
  ]
    .join("\n")
    .slice(0, BODY_MAX);
  const sep = body.trim().length > 0 ? "\n\n" : "";
  const room = BODY_MAX - section.length - sep.length;
  m.body = room > 0 ? body.slice(0, room) + sep + section : section;
}

function isPipelineStageRun(payload: unknown): boolean {
  const stage =
    payload && typeof payload === "object" ? (payload as { stage?: unknown }).stage : undefined;
  return typeof stage === "string" && stage.length > 0;
}

export function applyHandBackFields(
  m: Record<string, unknown>,
  opts: { costV2: boolean; payload: unknown },
): void {
  if (opts.costV2 && !isPipelineStageRun(opts.payload)) {
    markIncompleteProposal(m);
    return;
  }
  delete m.incomplete;
  delete m.remaining;
}
