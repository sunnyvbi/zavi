
import type { PlaybookDef } from "./index";

export function buildPlaybookDirective(pb: PlaybookDef): string {
  return [
    `── PLAYBOOK RUN: "${pb.title}" ──`,
    `You were launched as the "${pb.title}" playbook. Your ONE job this run:`,
    pb.outcome,
    ``,
    `Work it against real data (${pb.data_used.join(", ")}). Then PROPOSE the`,
    `action(s) for the operator to approve using your normal approval-gated`,
    `proposal tools (the propose_* / draft tools you already have) — do NOT take`,
    `the side effect yourself; the operator's Approve in the approvals queue is`,
    `what executes it. Make each proposal complete and ready-to-approve (the`,
    `drafted email, the exact ad-set + new value, etc.), with a one-line rationale.`,
    ``,
    `HARD RULES:`,
    `- If there is genuinely nothing to act on (nothing stalled / nothing over`,
    `  target), say so plainly and propose NOTHING — never invent an action.`,
    `- Ground every number in the real data you pulled. Never fabricate counts,`,
    `  names, or amounts.`,
    `- Stay on this playbook's job — don't wander into unrelated work.`,
  ].join("\n");
}
