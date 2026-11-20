
import { claimTenantFlag, getBoolSetting, getBoolSettingStrictResolved, setTenantSetting } from "@/services/settings";
import { asTenantId, staffCrossTenantClient, tenantClient } from "@/services/tenant-client";
import { growthPlanUrl, webBaseUrl } from "@/services/web-base";
import { resolveSequenceRecipient, sendPlanReadyEmail, type SequenceRecipient } from "@/email/sendAuthEmail";
import { greetingName } from "@/email/templates/onboarding-sequence";
import { DOGFOOD_SLUGS } from "@/services/tenants/new-tenant-alert";
import { isDefiniteSendRejection } from "@/services/onboarding-emails/send-errors";
import { unsubscribeUrlFor } from "@/services/onboarding-emails/sequence";
import { logEvent } from "@/services/logging/logEvent";
import { READY_EMAIL_CLAIM_KEY } from "./ready-email-claim";

export const PLAN_READY_EMAIL_EVENT = "growth/plan-ready.email";
export const PLAN_READY_EMAIL_DELAY = "3m";
const CLAIMER = "system:plan-ready-email";

export async function armPlanReadyEmail(tenant_id: string, run_id: string): Promise<void> {
  const { inngest } = await import("../../../workers/client");
  await inngest.send({
    id: `plan-ready-email-${tenant_id}`,
    name: PLAN_READY_EMAIL_EVENT,
    data: { run_id, tenant_id },
  });
}

export type PlanReadyFacts = {
  enabled: boolean;
  mailable: boolean;
  appliedPlans: number;
  planOpened: boolean;
  owner: { user_id: string; optedOut: boolean; unsubToken: string | null } | null;
  company: string;
};

export type PlanReadySkip =
  | "disabled"
  | "not_mailable"
  | "no_plan"
  | "not_first_plan"
  | "plan_opened"
  | "no_owner"
  | "opted_out";

export function planReadyDecision(f: PlanReadyFacts): { send: true } | { send: false; reason: PlanReadySkip } {
  if (!f.enabled) return { send: false, reason: "disabled" };
  if (!f.mailable) return { send: false, reason: "not_mailable" };
  if (f.appliedPlans < 1) return { send: false, reason: "no_plan" };
  if (f.appliedPlans > 1) return { send: false, reason: "not_first_plan" };
  if (f.planOpened) return { send: false, reason: "plan_opened" };
  if (!f.owner) return { send: false, reason: "no_owner" };
  if (f.owner.optedOut) return { send: false, reason: "opted_out" };
  return { send: true };
}

export type PlanReadyOutcome =
  | { sent: true }
  | { sent: false; reason: PlanReadySkip | "run_not_found" | "no_address" | "unverified" | "already_claimed" | "failed" | "unconfirmed" };

export type PlanReadyDeps = {
  tenantOfRun: (run_id: string) => Promise<string | null>;
  facts: (tenant_id: string) => Promise<PlanReadyFacts>;
  resolveRecipient: (user_id: string) => Promise<SequenceRecipient | null>;
  claim: (tenant_id: string) => Promise<boolean>;
  release: (tenant_id: string) => Promise<void>;
  send: typeof sendPlanReadyEmail;
  links: (tenant_id: string) => { planUrl: string; imageBaseUrl: string };
};

function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`plan-ready email: ${what} read failed: ${res.error.message}`);
  return res.data;
}

async function loadFacts(tenant_id: string): Promise<PlanReadyFacts> {
  const db = tenantClient(asTenantId(tenant_id));
  const enabled = await getBoolSettingStrictResolved("onboarding_email_sequence_enabled", tenant_id);
  const tenant = must(
    await db.from("tenants").select("slug, kind, deleted_at, display_name").maybeSingle(),
    "tenant",
  ) as { slug: string | null; kind: string | null; deleted_at: string | null; display_name: string | null } | null;
  const mailable =
    !!tenant && tenant.kind !== "test" && !tenant.deleted_at && !(tenant.slug && DOGFOOD_SLUGS.has(tenant.slug));
  const plans = must(
    await db.from("growth_strategy_delivery").select("run_id").not("plan_id", "is", null).limit(5),
    "plans",
  ) as unknown[] | null;
  const progress = must(
    await db.from("tenant_first_run_progress").select("plan_opened_at").maybeSingle(),
    "progress",
  ) as { plan_opened_at: string | null } | null;
  const ownerRow = must(
    await db
      .from("tenant_users")
      .select("user_id, created_at")
      .eq("role", "owner")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    "owner",
  ) as { user_id: string } | null;
  let owner: PlanReadyFacts["owner"] = null;
  if (ownerRow?.user_id) {
    const seq = must(
      await staffCrossTenantClient("plan-ready email: honour a person-wide onboarding opt-out")
        .from("onboarding_email_sequence")
        .select("status, unsub_token")
        .eq("user_id", ownerRow.user_id),
      "opt-out",
    ) as Array<{ status: string; unsub_token: string | null }> | null;
    const rows = seq ?? [];
    owner = {
      user_id: ownerRow.user_id,
      optedOut: rows.some((r) => r.status === "unsubscribed"),
      unsubToken: rows.find((r) => r.unsub_token)?.unsub_token ?? null,
    };
  }
  return {
    enabled,
    mailable,
    appliedPlans: (plans ?? []).length,
    planOpened: typeof progress?.plan_opened_at === "string",
    owner,
    company: (tenant?.display_name ?? "").trim(),
  };
}

export const planReadyDeps: PlanReadyDeps = {
  async tenantOfRun(run_id) {
    const row = must(
      await staffCrossTenantClient("plan-ready email: derive the workspace from the run (C8)")
        .from("agent_runs")
        .select("tenant_id")
        .eq("id", run_id)
        .maybeSingle(),
      "run",
    ) as { tenant_id: string } | null;
    return row?.tenant_id ?? null;
  },
  facts: loadFacts,
  resolveRecipient: (user_id) => resolveSequenceRecipient(user_id),
  claim: (tenant_id) => claimTenantFlag(tenant_id, READY_EMAIL_CLAIM_KEY, CLAIMER),
  async release(tenant_id) {
    try {
      await setTenantSetting(tenant_id, READY_EMAIL_CLAIM_KEY, null, CLAIMER);
    } catch (e) {
      await logEvent({ level: "warn", source: "growth.plan-ready-email", code: "plan_ready_claim_release_failed", tenant_id, error: e });
    }
  },
  send: (args) => sendPlanReadyEmail(args),
  links: (tenant_id) => {
    const planUrl = new URL(growthPlanUrl(tenant_id));
    planUrl.searchParams.set("utm_source", "email");
    planUrl.searchParams.set("utm_medium", "zavi");
    planUrl.searchParams.set("utm_campaign", "plan_ready");
    return { planUrl: planUrl.toString(), imageBaseUrl: webBaseUrl() };
  },
};

export async function maybeSendPlanReadyEmail(run_id: string, deps: PlanReadyDeps = planReadyDeps): Promise<PlanReadyOutcome> {
  const tenant_id = await deps.tenantOfRun(run_id);
  if (!tenant_id) return { sent: false, reason: "run_not_found" };
  const facts = await deps.facts(tenant_id);
  const decision = planReadyDecision(facts);
  if (!decision.send) return { sent: false, reason: decision.reason };
  const owner = facts.owner!;

  const who = await deps.resolveRecipient(owner.user_id);
  if (!who) return { sent: false, reason: "no_address" };
  if (!who.verified) return { sent: false, reason: "unverified" };

  if (!(await deps.claim(tenant_id))) return { sent: false, reason: "already_claimed" };

  const links = deps.links(tenant_id);
  try {
    await deps.send({
      to: who.email,
      firstName: greetingName(who.name),
      company: facts.company,
      planUrl: links.planUrl,
      imageBaseUrl: links.imageBaseUrl,
      unsubscribeUrl: owner.unsubToken ? unsubscribeUrlFor(owner.unsubToken) : "",
    });
  } catch (e) {
    if (isDefiniteSendRejection(e)) {
      await deps.release(tenant_id);
      return { sent: false, reason: "failed" };
    }
    await logEvent({ level: "warn", source: "growth.plan-ready-email", code: "plan_ready_send_unconfirmed", tenant_id, error: e });
    return { sent: false, reason: "unconfirmed" };
  }
  return { sent: true };
}

export const PLAN_READY_SWEEP_MIN_AGE_MS = 15 * 60 * 1000;
export const PLAN_READY_SWEEP_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const PLAN_READY_SWEEP_LIMIT = 100;
const SWEEP_PAGE = 200;
const SWEEP_MAX_PAGES = 10;

export type SweepRow = { tenant_id: string; run_id: string; updated_at: string };

export type PlanReadySweepDeps = {
  appliedPlans: (from: string, to: string, after: { updated_at: string; run_id: string } | null, size: number) => Promise<SweepRow[]>;
  claimed: (tenant_id: string) => Promise<boolean>;
  send: (run_id: string) => Promise<PlanReadyOutcome>;
  settle: (run_id: string) => Promise<void>;
};

const sweepClient = () => staffCrossTenantClient("plan-ready email sweep: first plans whose email was never armed");

const realSweepDeps: PlanReadySweepDeps = {
  async appliedPlans(from, to, after, size) {
    let q = sweepClient()
      .from("growth_strategy_delivery")
      .select("tenant_id, run_id, updated_at")
      .eq("phase", "applied")
      .not("plan_id", "is", null)
      .is("ready_email_settled_at", null)
      .gte("updated_at", from)
      .lte("updated_at", to);
    if (after) q = q.or(`updated_at.gt."${after.updated_at}",and(updated_at.eq."${after.updated_at}",run_id.gt.${after.run_id})`);
    return (must(
      await q.order("updated_at", { ascending: true }).order("run_id", { ascending: true }).limit(size),
      "applied plans",
    ) ?? []) as SweepRow[];
  },
  claimed: (tenant_id) => getBoolSetting(READY_EMAIL_CLAIM_KEY, tenant_id),
  send: (run_id) => maybeSendPlanReadyEmail(run_id),
  async settle(run_id) {
    const { error } = await sweepClient()
      .from("growth_strategy_delivery")
      .update({ ready_email_settled_at: new Date().toISOString() })
      .eq("run_id", run_id);
    if (error) throw new Error(`plan-ready email sweep: settle failed: ${error.message}`);
  },
};

const FINAL_SKIPS = new Set<string>(["already_claimed", "unconfirmed", "plan_opened", "not_first_plan", "opted_out", "not_mailable", "run_not_found"]);

export function sweepOutcomeIsFinal(o: PlanReadyOutcome): boolean {
  return o.sent || FINAL_SKIPS.has(o.reason);
}

export async function sweepPlanReadyEmails(
  now: Date = new Date(),
  deps: PlanReadySweepDeps = realSweepDeps,
): Promise<{ checked: number; sent: number; settled: number; failed: number }> {
  const from = new Date(now.getTime() - PLAN_READY_SWEEP_MAX_AGE_MS).toISOString();
  const to = new Date(now.getTime() - PLAN_READY_SWEEP_MIN_AGE_MS).toISOString();
  const seen = new Set<string>();
  const out = { checked: 0, sent: 0, settled: 0, failed: 0 };
  let after: { updated_at: string; run_id: string } | null = null;
  for (let page = 0; page < SWEEP_MAX_PAGES && out.checked + out.failed < PLAN_READY_SWEEP_LIMIT; page++) {
    const rows = await deps.appliedPlans(from, to, after, SWEEP_PAGE);
    for (const r of rows) {
      after = { updated_at: r.updated_at, run_id: r.run_id };
      if (seen.has(r.tenant_id) || out.checked + out.failed >= PLAN_READY_SWEEP_LIMIT) continue;
      seen.add(r.tenant_id);
      try {
        let final = true;
        if (!(await deps.claimed(r.tenant_id))) {
          out.checked += 1;
          const o = await deps.send(r.run_id);
          if (o.sent) out.sent += 1;
          final = sweepOutcomeIsFinal(o);
        }
        if (final) {
          await deps.settle(r.run_id);
          out.settled += 1;
        }
      } catch (e) {
        out.failed += 1;
        await logEvent({ level: "warn", source: "growth.plan-ready-email", code: "plan_ready_sweep_failed", tenant_id: r.tenant_id, error: e });
      }
    }
    if (rows.length < SWEEP_PAGE) break;
  }
  return out;
}
