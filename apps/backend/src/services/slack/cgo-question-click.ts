
import type { AnswerOutcome } from "@/services/growth/cgo-answers";

export type CgoQuestionClick = {
  team_id: string;
  slack_user_id: string;
  question_id: string;
  answer: "yes" | "no";
  message_blocks?: unknown[];
};

export type CgoQuestionClickDeps = {
  tenantForTeam: (team_id: string) => Promise<string | null>;
  ownerSlackUser: (tenant_id: string, team_id: string) => Promise<string | null>;
  ownerUserId: (tenant_id: string) => Promise<string | null>;
  answer: (a: { tenant_id: string; question_id: string; answer: "yes" | "no"; actor_user_id: string | null }) => Promise<AnswerOutcome>;
  now?: () => Date;
};

export type CgoQuestionClickResult =
  | { ok: false; code: "unknown_team" | "not_owner" }
  | { ok: true; outcome: AnswerOutcome; blocks: unknown[] | null; ephemeral: string | null };

export async function handleCgoQuestionClick(c: CgoQuestionClick, deps: CgoQuestionClickDeps): Promise<CgoQuestionClickResult> {
  const tenant_id = await deps.tenantForTeam(c.team_id);
  if (!tenant_id) return { ok: false, code: "unknown_team" };
  const owner = await deps.ownerSlackUser(tenant_id, c.team_id).catch(() => null);
  if (!owner || owner !== c.slack_user_id) return { ok: false, code: "not_owner" };
  const outcome = await deps.answer({
    tenant_id,
    question_id: c.question_id,
    answer: c.answer,
    actor_user_id: await deps.ownerUserId(tenant_id).catch(() => null),
  });
  const { answeredContext } = await import("@/services/growth/cgo-note-slack");
  const now = deps.now?.() ?? new Date();
  let line: string | null = null;
  let ephemeral: string | null = null;
  if (outcome.outcome === "answered") {
    line = answeredContext(outcome.answer, "slack", now);
    if (outcome.applied) line += `\n${outcome.applied}`;
    if (outcome.note) line += `\n${outcome.note}`;
  } else if (outcome.outcome === "already_answered") {
    line = `Already answered: *${outcome.answer === "yes" ? "Yes" : outcome.answer === "no" ? "No" : "answered"}*${outcome.via ? ` via ${outcome.via === "slack" ? "Slack" : outcome.via === "web" ? "the web" : "email"}` : ""}`;
  } else {
    ephemeral = "That question is no longer open.";
  }
  const blocks = line && c.message_blocks ? redraw(c.message_blocks, c.question_id, line) : null;
  return { ok: true, outcome, blocks, ephemeral };
}

export function redraw(blocks: unknown[], question_id: string, line: string): unknown[] {
  return blocks.map((b) =>
    (b as { type?: string; block_id?: string }).type === "actions" && (b as { block_id?: string }).block_id === `cgo_q:${question_id}`
      ? { type: "context", block_id: `cgo_q:${question_id}`, elements: [{ type: "mrkdwn", text: line }] }
      : b,
  );
}
