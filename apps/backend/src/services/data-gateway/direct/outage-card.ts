import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { outageTimeLabel } from "./reachability";

export const OUTAGE_CLASS = "operator_db.unreachable";
const RECHECK_MS = 5 * 60 * 1000;

export type OutageDeps = {
  claimOutage: (tenant_id: string) => Promise<string | null>;
  rollbackClaim: (tenant_id: string, since: string) => Promise<void>;
  emitCard: (tenant_id: string, body: Record<string, unknown>) => Promise<string | null>;
  storeCardId: (tenant_id: string, decision_id: string, since: string) => Promise<boolean>;
  readOutage: (tenant_id: string) => Promise<{ since: string; decision_id: string | null } | null>;
  supersedeCard: (tenant_id: string, decision_id: string) => Promise<void>;
  releaseOutage: (tenant_id: string, since: string) => Promise<void>;
  supersedeOpenCards: (tenant_id: string, before: string) => Promise<void>;
  log: typeof logEvent;
};

type Res<T> = { data: T | null; error: { message?: string } | null };

function ok<T>(r: Res<T>): T | null {
  if (r.error) throw new Error(r.error.message ?? "write failed");
  return r.data;
}

const cfg = (tenant_id: string) => tenantClient(asTenantId(tenant_id)).from("tenant_db_config");

export const DEFAULT_OUTAGE_DEPS: OutageDeps = {
  async claimOutage(tenant_id) {
    const rows = ok(
      (await cfg(tenant_id)
        .update({ unreachable_since: new Date().toISOString() })
        .eq("mode", "direct")
        .is("unreachable_since", null)
        .select("unreachable_since")) as Res<Array<{ unreachable_since: string }>>,
    );
    return rows?.[0]?.unreachable_since ?? null;
  },
  async rollbackClaim(tenant_id, since) {
    ok(
      (await cfg(tenant_id)
        .update({ unreachable_since: null })
        .eq("mode", "direct")
        .eq("unreachable_since", since)
        .is("unreachable_decision_id", null)) as Res<unknown>,
    );
  },
  async emitCard(tenant_id, body) {
    const id = ok(
      (await tenantRpc(asTenantId(tenant_id), "emit_decision", {
        p_agent_run_id: null,
        p_decision_class: OUTAGE_CLASS,
        p_body: body,
      })) as Res<string>,
    );
    return typeof id === "string" && id.length > 0 ? id : null;
  },
  async storeCardId(tenant_id, decision_id, since) {
    const rows = ok(
      (await cfg(tenant_id)
        .update({ unreachable_decision_id: decision_id })
        .eq("mode", "direct")
        .eq("unreachable_since", since)
        .select("unreachable_decision_id")) as Res<unknown[]>,
    );
    return (rows?.length ?? 0) > 0;
  },
  async readOutage(tenant_id) {
    const row = ok(
      (await cfg(tenant_id)
        .select("unreachable_since, unreachable_decision_id")
        .eq("mode", "direct")
        .maybeSingle()) as Res<{ unreachable_since: string | null; unreachable_decision_id: string | null }>,
    );
    return row?.unreachable_since ? { since: row.unreachable_since, decision_id: row.unreachable_decision_id } : null;
  },
  async supersedeCard(tenant_id, decision_id) {
    ok(
      (await tenantClient(asTenantId(tenant_id))
        .from("decisions")
        .update({ status: "superseded", superseded_at: new Date().toISOString() })
        .eq("id", decision_id)
        .eq("decision_class", OUTAGE_CLASS)
        .eq("status", "proposed")) as Res<unknown>,
    );
  },
  async releaseOutage(tenant_id, since) {
    ok(
      (await cfg(tenant_id)
        .update({ unreachable_since: null, unreachable_decision_id: null })
        .eq("mode", "direct")
        .eq("unreachable_since", since)) as Res<unknown>,
    );
  },
  async supersedeOpenCards(tenant_id, before) {
    ok(
      (await tenantClient(asTenantId(tenant_id))
        .from("decisions")
        .update({ status: "superseded", superseded_at: new Date().toISOString() })
        .eq("decision_class", OUTAGE_CLASS)
        .eq("status", "proposed")
        .lt("emitted_at", before)) as Res<unknown>,
    );
  },
  log: (i) => logEvent(i),
};

export function outageCardBody(outage_started_at: string, founderText: string): Record<string, unknown> {
  const when = outageTimeLabel(outage_started_at) ?? "recently";
  return {
    kind: "operator_db_unreachable",
    outage_started_at,
    rationale: "Your database can't be reached",
    rendered_markdown:
      `Zavi hasn't been able to connect to your database since ${when}. ` +
      "Answers and reports that need your data can't run until it's back.\n\n" +
      `${founderText}\n\n` +
      "This card clears itself the next time Zavi reads your database.",
  };
}

const lastCheck = new Map<string, number>();

async function fail(deps: OutageDeps, tenant_id: string, code: string, e: unknown): Promise<void> {
  await deps.log({ level: "error", source: "data-gateway.direct", code, tenant_id, error: e }).catch(() => undefined);
}

export async function raiseOutage(tenant_id: string, founderText: string, deps: OutageDeps = DEFAULT_OUTAGE_DEPS): Promise<void> {
  let since: string | null;
  try {
    since = await deps.claimOutage(tenant_id);
  } catch (e) {
    await fail(deps, tenant_id, "operator_db_unreachable_claim_failed", e);
    return;
  }
  if (!since) return;
  const rollback = () =>
    deps.rollbackClaim(tenant_id, since!).catch((err) => fail(deps, tenant_id, "operator_db_unreachable_rollback_failed", err));
  try {
    await deps.supersedeOpenCards(tenant_id, since);
  } catch (e) {
    await fail(deps, tenant_id, "operator_db_unreachable_sweep_failed", e);
    await rollback();
    return;
  }

  let id: string | null;
  try {
    id = await deps.emitCard(tenant_id, outageCardBody(since, founderText));
  } catch (e) {
    await fail(deps, tenant_id, "operator_db_unreachable_card_failed", e);
    await rollback();
    return;
  }
  if (!id) {
    await rollback();
    return;
  }
  try {
    const stored = await deps.storeCardId(tenant_id, id, since);
    if (!stored) await deps.supersedeCard(tenant_id, id);
  } catch (e) {
    await fail(deps, tenant_id, "operator_db_unreachable_store_failed", e);
    await deps.supersedeCard(tenant_id, id).catch((err) => fail(deps, tenant_id, "operator_db_unreachable_retract_failed", err));
    await rollback();
  }
}

export async function clearOutageIfOpen(
  tenant_id: string,
  opts: { sawFailure: boolean; now?: number },
  deps: OutageDeps = DEFAULT_OUTAGE_DEPS,
): Promise<void> {
  const now = opts.now ?? Date.now();
  const last = lastCheck.get(tenant_id);
  if (!opts.sawFailure && last !== undefined && now - last < RECHECK_MS) return;
  lastCheck.set(tenant_id, now);
  if (lastCheck.size > 10_000) lastCheck.delete(lastCheck.keys().next().value as string);
  const cutoff = new Date().toISOString();
  try {
    const open = await deps.readOutage(tenant_id);
    if (!open) {
      await deps.supersedeOpenCards(tenant_id, cutoff);
      return;
    }
    if (open.decision_id) await deps.supersedeCard(tenant_id, open.decision_id);
    await deps.releaseOutage(tenant_id, open.since);
  } catch (e) {
    lastCheck.delete(tenant_id);
    await fail(deps, tenant_id, "operator_db_unreachable_clear_failed", e);
  }
}

export function __resetOutageCard(): void {
  lastCheck.clear();
}
