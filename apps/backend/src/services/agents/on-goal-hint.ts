
import {
  getActiveGoals as fetchActiveGoalsDefault,
  type ActiveGoal as AutopilotActiveGoal,
} from "@/services/autopilot/goal-measurement";

export type OnGoalRelevance = boolean | "unknown";

export type OnGoalHint = {
  relevant: OnGoalRelevance;
  note: string;
};

export type ActiveGoal = AutopilotActiveGoal;

const SELF_INITIATED_TRIGGERS: ReadonlySet<string> = new Set([
  "cron",
  "scheduled",
  "playbook",
]);

export function isSelfInitiatedTrigger(trigger: string): boolean {
  return SELF_INITIATED_TRIGGERS.has(trigger);
}

const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "your",
  "into",
  "will",
  "have",
  "more",
  "than",
  "then",
  "value",
  "target",
  "metric",
  "goal",
  "current",
]);

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 4 && !STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function actionText(body: unknown, decisionClass: string): string {
  const b =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return [
    decisionClass.replace(/[._-]+/g, " "),
    str(b.title),
    str(b.summary),
    str(b.rationale),
    str(b.subject),
    str(b.description),
    str(b.intent),
  ].join(" ");
}

function truncate(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function computeOnGoalHint(input: {
  trigger: string;
  decisionClass: string;
  body: unknown;
  activeGoals: ActiveGoal[];
}): OnGoalHint | null {
  if (!isSelfInitiatedTrigger(input.trigger)) return null;

  if (input.activeGoals.length === 0) {
    return {
      relevant: "unknown",
      note: "No active goal on file to check this against.",
    };
  }

  const actionTokens = tokenize(actionText(input.body, input.decisionClass));

  for (const g of input.activeGoals) {
    const goalTokens = tokenize(`${g.objective} ${g.target_metric ?? ""}`);
    let overlaps = false;
    for (const t of goalTokens) {
      if (actionTokens.has(t)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) {
      return {
        relevant: true,
        note: `Appears to advance your active goal: "${truncate(g.objective)}".`,
      };
    }
  }

  const names = input.activeGoals
    .slice(0, 3)
    .map((g) => `"${truncate(g.objective, 40)}"`)
    .join(", ");
  return {
    relevant: false,
    note: `No clear link to your active goal(s): ${names}. Worth a second look.`,
  };
}

export async function maybeAttachOnGoalHint(
  input: {
    tenant_id: string;
    trigger: string;
    decisionClass: string;
    body: unknown;
  },
  deps: {
    fetchActiveGoals?: (tenant_id: string) => Promise<ActiveGoal[]>;
  } = {},
): Promise<unknown> {
  try {
    if (!isSelfInitiatedTrigger(input.trigger)) return input.body;
    if (!input.body || typeof input.body !== "object") return input.body;

    const fetch = deps.fetchActiveGoals ?? fetchActiveGoalsDefault;
    const activeGoals = await fetch(input.tenant_id);

    const hint = computeOnGoalHint({
      trigger: input.trigger,
      decisionClass: input.decisionClass,
      body: input.body,
      activeGoals,
    });
    if (!hint) return input.body;

    return { ...(input.body as Record<string, unknown>), on_goal_hint: hint };
  } catch (e) {
    console.warn(
      `[on-goal-hint] attach failed (fail-open, body unchanged): ${(e as Error).message}`,
    );
    return input.body;
  }
}
