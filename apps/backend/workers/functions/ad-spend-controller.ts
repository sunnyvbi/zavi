
import { inngest } from "../client";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { isCanonicalContainer } from "@/services/agents/boot-role";
import { runSpendControllerForTenant, type ControllerOutcome } from "@/services/growth/ad-spend-controller";
import { sweepStuckAdChanges } from "@/services/growth/stuck-ad-changes";
import { monitorTestStops, tenantsWithTestStops } from "@/services/growth/test-stops";
import { flushAllPendingCgoNotes } from "@/services/growth/cgo-note-notifications";
import { tenantsWithActiveBudgets } from "./cgo-budget-review";
import { alertMoneyJobErrors } from "./_money-job-alert";
import { logJobError } from "./_job-errors";

export async function tidyHeldQuestions(tenant_id: string, passStart: Date): Promise<void> {
  try {
    const { clearStaleHolds, HOLD_FRESH_MS } = await import("@/services/growth/ad-holds");
    await clearStaleHolds(tenant_id, new Date(passStart.getTime() - HOLD_FRESH_MS));
    const { withdrawSettledAdQuestions } = await import("@/services/growth/settled-questions");
    await withdrawSettledAdQuestions(tenant_id, passStart);
  } catch (e) {
    console.warn(`[ad-spend-controller] settled questions for ${tenant_id}: ${(e as Error).message}`);
  }
}

export async function runTestStopPass(
  now: Date,
  deps: { testStopTenants?: () => Promise<string[]>; monitorTestStops?: (tenant_id: string, now: Date) => Promise<unknown> } = {},
): Promise<{ tenants: number; errors: number }> {
  let tenants: string[];
  try {
    tenants = await (deps.testStopTenants ?? (() => tenantsWithTestStops(now)))();
  } catch (e) {
    await logJobError("ad-spend-controller", `test stops: tenant list unreadable: ${(e as Error).message}`);
    await alertMoneyJobErrors("ad-spend-controller:test-stops", ["(tenant list)"], 1);
    return { tenants: 0, errors: 1 };
  }
  const failed: string[] = [];
  for (const t of tenants) {
    try {
      await (deps.monitorTestStops ?? monitorTestStops)(t, now);
    } catch (e) {
      failed.push(t);
      await logJobError("ad-spend-controller", `test stops: tenant ${t}: ${(e as Error).message}`);
    }
  }
  if (failed.length) await alertMoneyJobErrors("ad-spend-controller:test-stops", failed, tenants.length);
  return { tenants: tenants.length, errors: failed.length };
}

export async function runAdSpendControllerTick(
  now: Date = new Date(),
  deps: {
    sweepStuck?: (now: Date) => Promise<unknown>;
    flushNotes?: () => Promise<unknown>;
    afterTenant?: (tenant_id: string, now: Date) => Promise<void>;
    testStopTenants?: () => Promise<string[]>;
    monitorTestStops?: (tenant_id: string, now: Date) => Promise<unknown>;
  } = {},
) {
  if (isWorkerCronStopped("ad-spend-controller")) return { cron_stopped: true as const };
  const stops = await runTestStopPass(now, deps);
  const tenants = await tenantsWithActiveBudgets();
  const results: ControllerOutcome[] = [];
  for (const t of tenants) {
    const r = await runSpendControllerForTenant(t, now);
    if (r.outcome === "error") await logJobError("ad-spend-controller", `tenant ${t}: ${r.error}`);
    results.push(r);
    if (r.outcome === "ran") await (deps.afterTenant ?? tidyHeldQuestions)(t, now);
  }
  const stuck = await (deps.sweepStuck ?? sweepStuckAdChanges)(now).catch((e) => {
    console.warn(`[ad-spend-controller] stuck ad changes sweep: ${(e as Error).message}`);
    return null;
  });
  const pending_notes = await (deps.flushNotes ?? flushAllPendingCgoNotes)().catch((e) => {
    console.warn(`[ad-spend-controller] pending cgo notes: ${(e as Error).message}`);
    return null;
  });
  await alertMoneyJobErrors(
    "ad-spend-controller",
    results.filter((r) => r.outcome === "error").map((r) => r.tenant_id),
    tenants.length,
  );
  return {
    stuck,
    pending_notes,
    test_stops: stops,
    tenants: tenants.length,
    ran: results.filter((r) => r.outcome === "ran").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    errors: results.filter((r) => r.outcome === "error").length,
  };
}

export const adSpendControllerFn = inngest.createFunction(
  { id: "ad-spend-controller", retries: 1, concurrency: { limit: 1 } },
  { cron: "41 * * * *" },
  async ({ step }) => {
    if (!isCanonicalContainer()) return { skipped: "not_canonical" as const };
    return step.run("control", () => runAdSpendControllerTick());
  },
);
