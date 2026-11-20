
import { tenantRealtimeFilter } from "@/components/workspace/brain/tenantScope";

export type RunEndThreadEvent = {
  id: number;
  kind: string;
  tenant_id: string | null;
  agent_slug: string;
  agent_run_id: string | null;
  thread_id: string | null;
  body: {
    status?: string;
    cost_usd?: number;
    answered?: boolean;
    trigger?: string;
    question?: boolean;
  } & Record<string, unknown>;
};

export type UnreadDecision =
  | { action: "skip"; reason: string }
  | { action: "mark"; dedupeKey: string; reason: string };

export function decideRunUnread(
  row: RunEndThreadEvent,
  ctx: { seenRunIds: ReadonlySet<string> },
): UnreadDecision {
  if (row.body?.status === "cancelled") {
    return { action: "skip", reason: "cancelled (user-initiated stop)" };
  }

  const dedupeKey = row.agent_run_id ?? `evt:${row.id}`;
  if (ctx.seenRunIds.has(dedupeKey)) {
    return { action: "skip", reason: "already handled" };
  }

  return { action: "mark", dedupeKey, reason: "completion" };
}

export type RunEndSubscriptionConfig = {
  table: "thread_event";
  event: "INSERT";
  scopeKey: string;
  filter: string;
};

export function buildRunEndSubscription(
  tenantId: string | null | undefined,
): RunEndSubscriptionConfig | null {
  if (typeof tenantId !== "string" || tenantId.length === 0) return null;
  return {
    table: "thread_event",
    event: "INSERT",
    scopeKey: `tenant:${tenantId}`,
    filter: tenantRealtimeFilter(tenantId),
  };
}

const NOTIFIABLE_TRIGGER = "chat";

export type RunToastDecision =
  | { action: "skip"; reason: string }
  | { action: "toast"; kind: "question" | "output"; dedupeKey: string };

export function decideRunToast(
  row: RunEndThreadEvent,
  ctx: { seenRunIds: ReadonlySet<string>; watching: boolean },
): RunToastDecision {
  if (row.body?.status !== "success") {
    return { action: "skip", reason: `not a success: ${row.body?.status ?? "absent"}` };
  }

  if (row.thread_id === null) {
    return { action: "skip", reason: "no thread to open" };
  }

  const dedupeKey = row.agent_run_id ?? `evt:${row.id}`;
  if (ctx.seenRunIds.has(dedupeKey)) {
    return { action: "skip", reason: "already handled" };
  }

  const trigger = row.body?.trigger;
  if (trigger !== NOTIFIABLE_TRIGGER) {
    return { action: "skip", reason: `trigger not notifiable: ${trigger ?? "absent"}` };
  }

  if (ctx.watching) {
    return { action: "skip", reason: "operator is watching this run" };
  }

  if (row.body?.question === true) {
    return { action: "toast", kind: "question", dedupeKey };
  }

  if (row.body?.answered !== true) {
    return { action: "skip", reason: "no deliverable to review" };
  }

  return { action: "toast", kind: "output", dedupeKey };
}
