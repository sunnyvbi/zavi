
import { randomUUID } from "node:crypto";
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { isCanonicalContainer } from "@/services/agents/boot-role";
import { computeAlarms, readWatchState } from "@/services/growth/cgo-watch";
import { enqueueGoalOwnerRun } from "@/services/growth/goal-owner";
import { recordWakeSkip } from "@/services/growth/cgo-wake-skips";
import { logJobError } from "./_job-errors";
import { isInsufficientCreditsError } from "@/services/agents/credits";
import { sweepCompanyCountries } from "@/services/company/country-inference";
import { tenantIsIdle } from "@/services/growth/tenant-idle";

export type TenantCheck =
  | { tenant_id: string; outcome: "quiet" }
  | { tenant_id: string; outcome: "woke"; reasons: string[] }
  | { tenant_id: string; outcome: "skipped"; why: string }
  | { tenant_id: string; outcome: "error"; error: string };

export async function checkTenant(tenant_id: string, now: Date = new Date()): Promise<TenantCheck> {
  try {
    if (await tenantIsIdle(tenant_id, now)) {
      void recordWakeSkip(tenant_id, "daily_check", "idle_7d");
      return { tenant_id, outcome: "skipped", why: "idle" };
    }
    const state = await readWatchState(tenant_id, now);
    if (state.goals.length === 0) return { tenant_id, outcome: "quiet" };
    const { getBoolSettingStrictResolved } = await import("@/services/settings");
    const autopilot = await getBoolSettingStrictResolved("cgo_autopilot_enabled", tenant_id);
    const alarms = computeAlarms(state, now, { autopilot });
    if (!alarms.wake) {
      void recordWakeSkip(tenant_id, "daily_check", "nothing_due");
      return { tenant_id, outcome: "quiet" };
    }
    const r = await enqueueGoalOwnerRun({
      tenant_id,
      reason: "daily_check",
      check: { kind: alarms.kind, reasons: alarms.reasons, alarm_keys: alarms.keys },
      now,
    });
    if (!r.enqueued) return { tenant_id, outcome: "skipped", why: r.skipped };
    return { tenant_id, outcome: "woke", reasons: alarms.reasons };
  } catch (e) {
    const err = e as Error | null;
    if (err?.name === "InsufficientCreditsError" || isInsufficientCreditsError(err)) {
      return { tenant_id, outcome: "skipped", why: "no_credits" };
    }
    return { tenant_id, outcome: "error", error: (e as Error).message };
  }
}

export async function tenantsWithActiveGoals(): Promise<string[]> {
  return (await activeGoalTenants()).live;
}

async function activeGoalTenants(): Promise<{ live: string[]; left_out: string[] }> {
  const { data, error } = await serviceClient()
    .from("autopilot_goals")
    .select("tenant_id")
    .eq("status", "active")
    .limit(5000);
  if (error) throw new Error(`cgo-daily-check: tenant list failed: ${error.message}`);
  const all = [...new Set(((data ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id))];
  const live = await liveTenantIds(all);
  const kept = new Set(live);
  return { live, left_out: all.filter((t) => !kept.has(t)) };
}

export async function recordLeftOutTenants(left_out: readonly string[]): Promise<number> {
  const { getBoolSettingStrictResolved } = await import("@/services/settings");
  let n = 0;
  for (const t of left_out) {
    const on = await getBoolSettingStrictResolved("cgo_autopilot_enabled", t).catch(() => true);
    if (!on) continue;
    await recordWakeSkip(t, "daily_check", "not_live_tenant");
    n += 1;
  }
  return n;
}

export async function liveTenantIds(tenantIds: string[]): Promise<string[]> {
  const ids = [...new Set(tenantIds)];
  const keep: string[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data: rows, error: tErr } = await serviceClient()
      .from("tenants")
      .select("id")
      .in("id", ids.slice(i, i + 200))
      .or("kind.is.null,kind.neq.test")
      .is("deleted_at", null)
      .is("disabled_at", null);
    if (tErr) throw new Error(`cgo-daily-check: tenant kinds failed: ${tErr.message}`);
    keep.push(...((rows ?? []) as Array<{ id: string }>).map((r) => r.id));
  }
  return keep;
}

export async function tenantsWithOverdueQuestions(now: Date): Promise<string[]> {
  const { data, error } = await serviceClient()
    .from("cgo_questions")
    .select("tenant_id")
    .eq("status", "open")
    .lte("expires_at", now.toISOString())
    .limit(5000);
  if (error) throw new Error(`cgo-daily-check: overdue questions read failed: ${error.message}`);
  return liveTenantIds(((data ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id));
}

export async function sweepTenantQuestions(tenant_id: string, now: Date): Promise<{ expired: number; applied: number }> {
  const { getBoolSettingStrictResolved } = await import("@/services/settings");
  const autopilot = await getBoolSettingStrictResolved("cgo_autopilot_enabled", tenant_id);
  const { sweepExpiredQuestions } = await import("@/services/growth/cgo-questions");
  const out = await sweepExpiredQuestions(tenant_id, now, {
    autopilot,
    autopilotNow: () => getBoolSettingStrictResolved("cgo_autopilot_enabled", tenant_id),
  });
  if (out.applied.length === 0) return { expired: out.expired, applied: 0 };
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const db = tenantClient(asTenantId(tenant_id));
  const { data: last } = await db
    .from("cgo_notes")
    .select("next_review_at")
    .eq("tenant_id", tenant_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ next_review_at: string }>();
  const { data: note, error } = await db
    .from("cgo_notes")
    .insert({
      tenant_id,
      run_id: null,
      kind: "alarm",
      changed: out.applied,
      queued_at: now.toISOString(),
      notified: false,
      notification_key: `note:${randomUUID()}`,
      next_review_at: last?.next_review_at ?? new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    })
    .select("id")
    .maybeSingle<{ id: string }>();
  if (error || !note) {
    console.warn(`[cgo-daily-check] default note write failed for ${tenant_id}: ${error?.message ?? "no row"}`);
    return { expired: out.expired, applied: out.applied.length };
  }
  await inngest.send({ id: `cgo-note-email:note:${note.id}`, name: "cgo/note.email", data: { note_id: note.id, tenant_id } });
  return { expired: out.expired, applied: out.applied.length };
}

export const REMIND_AFTER_MS = 24 * 3_600_000;

export async function remindTenantQuestions(
  tenant_id: string,
  now: Date,
  send?: (tenant_id: string, qs: import("./cgo-goal-owner").OpenQuestionView[]) => Promise<unknown>,
): Promise<number> {
  const { asTenantId, tenantClient } = await import("@/services/tenant-client");
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("cgo_questions")
    .update({ reminded_at: now.toISOString() })
    .eq("tenant_id", tenant_id)
    .eq("status", "open")
    .is("reminded_at", null)
    .lte("asked_at", new Date(now.getTime() - REMIND_AFTER_MS).toISOString())
    .select("id");
  if (error) throw new Error(`cgo-daily-check: reminder claim failed: ${error.message}`);
  const ids = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
  if (ids.size === 0) return 0;
  const { loadOpenQuestions, sendQuestionReminder } = await import("./cgo-goal-owner");
  const qs = (await loadOpenQuestions(tenant_id, null)).filter((q) => ids.has(q.id));
  await (send ?? sendQuestionReminder)(tenant_id, qs);
  return qs.length;
}

async function tenantsWithQueuedQuestions(): Promise<string[]> {
  const { data, error } = await serviceClient().from("cgo_questions").select("tenant_id").eq("status", "queued").limit(5000);
  if (error) throw new Error(`cgo-daily-check: queued read failed: ${error.message}`);
  return liveTenantIds(((data ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id));
}

async function tenantsWithUnremindedQuestions(now: Date): Promise<string[]> {
  const { data, error } = await serviceClient()
    .from("cgo_questions")
    .select("tenant_id")
    .eq("status", "open")
    .is("reminded_at", null)
    .lte("asked_at", new Date(now.getTime() - REMIND_AFTER_MS).toISOString())
    .limit(5000);
  if (error) throw new Error(`cgo-daily-check: reminder read failed: ${error.message}`);
  return liveTenantIds(((data ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id));
}

async function tenantsWithAdQuestions(): Promise<string[]> {
  const { data, error } = await serviceClient()
    .from("cgo_questions")
    .select("tenant_id")
    .in("status", ["open", "queued"])
    .or("topic_key.like.held:%,topic_key.like.open-advice:%")
    .limit(5000);
  if (error) throw new Error(`cgo-daily-check: held question read failed: ${error.message}`);
  return liveTenantIds(((data ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id));
}

export async function runDailyCheck(now: Date = new Date()) {
  if (isWorkerCronStopped("cgo-daily-check")) return { cron_stopped: true as const };
  for (const t of await tenantsWithOverdueQuestions(now)) {
    try {
      await sweepTenantQuestions(t, now);
    } catch (e) {
      console.warn(`[cgo-daily-check] question sweep for ${t}: ${(e as Error).message}`);
    }
  }
  try {
    const { withdrawSettledAdQuestions } = await import("@/services/growth/settled-questions");
    for (const t of await tenantsWithAdQuestions()) {
      await withdrawSettledAdQuestions(t, now).catch((e) => console.warn(`[cgo-daily-check] settled questions for ${t}: ${(e as Error).message}`));
    }
  } catch (e) {
    console.warn(`[cgo-daily-check] settled questions: ${(e as Error).message}`);
  }
  try {
    const { promoteQueuedQuietly } = await import("@/services/growth/cgo-questions");
    for (const t of await tenantsWithQueuedQuestions()) await promoteQueuedQuietly(t, now);
  } catch (e) {
    console.warn(`[cgo-daily-check] queued questions: ${(e as Error).message}`);
  }
  try {
    for (const t of await tenantsWithUnremindedQuestions(now)) {
      await remindTenantQuestions(t, now).catch((e) => console.warn(`[cgo-daily-check] reminder for ${t}: ${(e as Error).message}`));
    }
  } catch (e) {
    console.warn(`[cgo-daily-check] reminders: ${(e as Error).message}`);
  }
  const { live: tenants, left_out } = await activeGoalTenants();
  const leftOutWithAutopilot = await recordLeftOutTenants(left_out);
  const results: TenantCheck[] = [];
  for (const t of tenants) {
    const r = await checkTenant(t, now);
    if (r.outcome === "error") {
      await logJobError("cgo-daily-check", `tenant ${t}: ${r.error}`);
      await recordWakeSkip(t, "daily_check", "error");
    }
    results.push(r);
  }
  return {
    tenants: tenants.length,
    left_out_with_autopilot: leftOutWithAutopilot,
    woke: results.filter((r) => r.outcome === "woke").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    errors: results.filter((r) => r.outcome === "error").length,
  };
}

export const cgoDailyCheckFn = inngest.createFunction(
  { id: "cgo-daily-check", retries: 1 },
  { cron: "0 14 * * *" },
  async ({ step }) => {
    if (!isCanonicalContainer()) return { skipped: "not_canonical" as const };
    const check = await step.run("check", () => runDailyCheck());
    const country = await step.run("company-country", async () => {
      try {
        return await sweepCompanyCountries();
      } catch (e) {
        console.warn(`[cgo-daily-check] company-country sweep: ${(e as Error).message}`);
        return { checked: 0, written: 0, error: (e as Error).message };
      }
    });
    const adRules = await step.run("ad-guard-scan", async () => {
      try {
        const { runAdGuardScan } = await import("@/services/rules/ad-guard-scan");
        return await runAdGuardScan();
      } catch (e) {
        console.warn(`[cgo-daily-check] ad-guard scan: ${(e as Error).message}`);
        return { tenants: 0, asked: 0, errors: 1 };
      }
    });
    return { ...check, company_country: country, ad_rules: adRules };
  },
);
