
import type { SupabaseClient } from "@supabase/supabase-js";

import { alert as defaultAlert } from "@/services/logging/alert";
import { isLiveStorePlan } from "@/services/billing/store-rail";

const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

type TenantRow = { id: string; display_name: string | null; slug: string | null };
type SubRow = {
  tenant_id: string;
  tier: string | null;
  status: string | null;
  source?: string | null;
  stripe_subscription_id: string | null;
  comp_expires_at: string | null;
};

export type AccountDeletedAlertInput = {
  sb: SupabaseClient;
  deletion_id: string;
  source: string;
  email: string | null;
  signed_up_at: string | null;
  last_sign_in_at: string | null;
  deleted_tenants: string[];
  left_tenants: string[];
  teardown_errors: number;
};

export function describePlan(sub: SubRow | undefined): { label: string; paid: boolean } {
  const tier = sub?.tier && sub.tier !== "free" ? sub.tier : null;
  if (!sub || !tier) return { label: "free", paid: false };
  if (sub.comp_expires_at) {
    return { label: `${tier}, comped until ${sub.comp_expires_at.slice(0, 10)}`, paid: false };
  }
  const live = !!sub.status && LIVE_STATUSES.has(sub.status);
  if (sub.stripe_subscription_id && live) {
    return { label: `${tier}, paid (Stripe, ${sub.status})`, paid: true };
  }
  if (isLiveStorePlan(sub)) {
    return { label: `${tier}, paid (${sub.source}, ${sub.status})`, paid: true };
  }
  return { label: `${tier} (status ${sub.status ?? "none"})`, paid: false };
}

function day(iso: string | null | undefined): string {
  return iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "unknown";
}

export async function notifyAccountDeleted(
  input: AccountDeletedAlertInput,
  deps: { alert: typeof defaultAlert } = { alert: defaultAlert },
): Promise<void> {
  try {
    const { sb } = input;
    const ids = [...input.deleted_tenants, ...input.left_tenants];

    let tenants: TenantRow[] = [];
    let subs: SubRow[] = [];
    let subsUnknown = false;
    let lastRunAt: string | null = null;
    if (ids.length > 0) {
      const [t, s, r] = await Promise.all([
        sb.from("tenants").select("id, display_name, slug").in("id", ids).then((x) => x, () => null),
        sb
          .from("tenant_subscriptions")
          .select("tenant_id, tier, status, source, stripe_subscription_id, comp_expires_at")
          .in("tenant_id", ids)
          .then((x) => x, () => null),
        sb
          .from("agent_runs")
          .select("enqueued_at")
          .in("tenant_id", ids)
          .order("enqueued_at", { ascending: false })
          .limit(1)
          .then((x) => x, () => null),
      ]);
      tenants = ((t?.data as TenantRow[] | null) ?? []);
      subsUnknown = !s || !!s.error || !s.data;
      subs = ((s?.data as SubRow[] | null) ?? []);
      lastRunAt = ((r?.data as { enqueued_at: string }[] | null) ?? [])[0]?.enqueued_at ?? null;
    }

    const byId = new Map(tenants.map((t) => [t.id, t]));
    const subById = new Map(subs.map((s) => [s.tenant_id, s]));
    let anyPaid = false;
    let deletedPaid = false;
    const line = (deleted: boolean) => (id: string): string => {
      const t = byId.get(id);
      const plan = subsUnknown ? { label: "unknown (plan read failed)", paid: false } : describePlan(subById.get(id));
      if (plan.paid) anyPaid = true;
      if (plan.paid && deleted) deletedPaid = true;
      return `  - ${t?.display_name || "(no name)"} (${t?.slug || "-"}, ${id}), plan: ${plan.label}`;
    };
    const deletedLines = input.deleted_tenants.map(line(true));
    const leftLines = input.left_tenants.map(line(false));

    const email = input.email || "(no email on file)";
    await deps.alert({
      source: "account-deleted",
      code: "account_deleted",
      msg:
        `An account was deleted (${input.source}): ${input.deleted_tenants.length} companies deleted, ` +
        `${input.left_tenants.length} left. Deletion ${input.deletion_id}.`,
      email: {
        dedupeKey: `account_deleted:${input.deletion_id}`,
        subjectDetail: `Account deleted: ${email}`,
        detail: [
          `Email: ${email}`,
          `Deleted from: ${input.source}`,
          `Signed up: ${day(input.signed_up_at)}`,
          `Last sign-in: ${day(input.last_sign_in_at)}`,
          `Latest agent run in their companies: ${day(lastRunAt)}`,
          `Paid plan: ${subsUnknown ? "unknown (plan read failed, check Billing)" : anyPaid ? "yes" : "no"}`,
          "",
          `Companies deleted (${deletedLines.length}):`,
          ...(deletedLines.length ? deletedLines : ["  none"]),
          `Companies left, others still there (${leftLines.length}):`,
          ...(leftLines.length ? leftLines : ["  none"]),
          "",
          input.teardown_errors > 0
            ? `Teardown hit ${input.teardown_errors} errors; see account_deletions ${input.deletion_id}.`
            : "Teardown finished cleanly.",
          deletedPaid || (subsUnknown && input.deleted_tenants.length > 0)
            ? "Deleting does not cancel a paid plan. Check the deleted companies' subscriptions were cancelled."
            : "",
        ]
          .filter((l, i, all) => !(l === "" && i === all.length - 1))
          .join("\n"),
      },
    });
  } catch (e) {
    console.warn(`[account-deleted-alert] email failed (deletion=${input.deletion_id}): ${(e as Error).message}`);
  }
}
