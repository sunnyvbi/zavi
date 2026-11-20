
import { inngest } from "../client";
import { readExecRow } from "./dispatch-channel-action";
import type { ReconcileResult, ReconcileTarget } from "@/services/connectors/email-campaign/reconcile";

const PASS_WAIT = "6m";
const MAX_PASSES = 5;
const NOTICE_RETRY_WAIT = "1h";
const NOTICE_RETRY_PASSES = 23;

export type ReconcileRunDeps = {
  readRow: (actionId: string) => Promise<ReconcileTarget | null>;
  reconcile: (actionId: string, t: ReconcileTarget, opts: { finalPass: boolean; lastPass: boolean }) => Promise<ReconcileResult | { done: boolean; outcome: string }>;
  log: (e: { code: string; message: string; tenant_id?: string }) => Promise<void>;
};

const DEFAULT_DEPS: ReconcileRunDeps = {
  readRow: readExecRow,
  reconcile: async (actionId, t, opts) => t.exec_class?.startsWith("reddit_ads.") ? (await import("@/services/connectors/reddit-ads/reconcile")).reconcileRedditAction(actionId, t) : (await import("@/services/connectors/email-campaign/reconcile")).reconcileEmailSend(actionId, t, opts),
  log: async (e) => {
    const { logEvent } = await import("@/services/logging/logEvent");
    await logEvent({ level: "warn", source: "reconcile-channel-action-exec", ...e });
  },
};

export async function runExecReconcilePass(actionId: string, pass: number, deps: Partial<ReconcileRunDeps> = {}): Promise<{ done: boolean; outcome: string }> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const row = await d.readRow(actionId);
  if (!row) return { done: true, outcome: "nothing_to_do" };
  const r = await d.reconcile(actionId, row, { finalPass: pass >= 1, lastPass: pass >= MAX_PASSES - 1 });
  if (r.outcome === "notify_failed") {
    await d.log({ code: "email_send.founder_notice_failed", message: `action ${actionId} pass ${pass}`, tenant_id: row.tenant_id }).catch(() => undefined);
  }
  return r;
}

export type ReconcileSteps = {
  sleep: (id: string, wait: string) => Promise<unknown>;
  run: (id: string, fn: () => Promise<{ done: boolean; outcome: string }>) => Promise<ReconcileResult | { done: boolean; outcome: string }>;
};

export async function runReconcileLoop(
  actionId: string,
  step: ReconcileSteps,
  pass: (n: number) => Promise<{ done: boolean; outcome: string }> = (n) => runExecReconcilePass(actionId, n),
): Promise<{ ok: true; outcome: string; passes: number }> {
  let last: { done: boolean; outcome: string } | null = null;
  for (let n = 0; n < MAX_PASSES; n++) {
    await step.sleep(`wait-${n}`, PASS_WAIT);
    last = await step.run(`reconcile-${n}`, () => pass(n));
    if (last.done) return { ok: true, outcome: last.outcome, passes: n + 1 };
  }
  for (let i = 0; last?.outcome === "notify_failed" && i < NOTICE_RETRY_PASSES; i++) {
    const n = MAX_PASSES + i;
    await step.sleep(`notice-wait-${i}`, NOTICE_RETRY_WAIT);
    last = await step.run(`reconcile-${n}`, () => pass(n));
    if (last.done) return { ok: true, outcome: last.outcome, passes: n + 1 };
  }
  return { ok: true, outcome: last?.outcome === "notify_failed" ? "notice_gave_up" : "gave_up", passes: MAX_PASSES + (last?.outcome === "notify_failed" ? NOTICE_RETRY_PASSES : 0) };
}

export const reconcileChannelActionExecFn = inngest.createFunction(
  { id: "reconcile-channel-action-exec", retries: 2 },
  { event: "channel-action.exec-reconcile" },
  async ({ event, step }) => {
    const action_id = String(event.data?.action_id ?? "");
    if (!action_id) return { ok: false, error: "missing_action_id" };
    return runReconcileLoop(action_id, {
      sleep: (id, wait) => step.sleep(id, wait),
      run: (id, fn) => step.run(id, fn) as Promise<{ done: boolean; outcome: string }>,
    });
  },
);

export function runDecisionEmailReconcilePass(decisionId: string, pass: number, reconcile: typeof import("@/services/connectors/email-campaign/reconcile-decision").reconcileDecisionEmailSend): Promise<ReconcileResult> {
  return reconcile(decisionId, { finalPass: pass >= 1, lastPass: pass >= MAX_PASSES - 1 });
}

export const reconcileDecisionEmailSendFn = inngest.createFunction(
  { id: "reconcile-decision-email-send", retries: 2 },
  { event: "decision.email-send-reconcile" },
  async ({ event, step }) => {
    const decision_id = String(event.data?.decision_id ?? "");
    if (!decision_id) return { ok: false, error: "missing_decision_id" };
    const { reconcileDecisionEmailSend } = await import("@/services/connectors/email-campaign/reconcile-decision");
    return runReconcileLoop(
      decision_id,
      {
        sleep: (id, wait) => step.sleep(id, wait),
        run: (id, fn) => step.run(id, fn) as Promise<{ done: boolean; outcome: string }>,
      },
      (n) => runDecisionEmailReconcilePass(decision_id, n, reconcileDecisionEmailSend),
    );
  },
);
