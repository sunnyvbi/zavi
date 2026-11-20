
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { adviseFounderOrder, isMetaOrGoogleAdClass } from "@/services/growth/founder-order";

type Row = { id: string; tenant_id: string; decision_class: string; body: unknown; status: string; agent_run_id?: string | null };

export type FounderAdviceDeps = {
  readRow: (decision_id: string) => Promise<Row | null>;
  evaluate: Parameters<typeof adviseFounderOrder>[4];
  write: (row: Row, advice: { warnings: string[]; at: string }) => Promise<boolean>;
  now: () => Date;
};

export type FounderAdviceResult =
  | { skipped: "not_found" | "not_founder_ad" | "not_proposed" }
  | { written: boolean; warnings: number };

export async function readDecisionRowById(decision_id: string): Promise<Row | null> {
  return readRowDefault(decision_id);
}

export async function readCardTenantById(table: "decisions" | "channel_actions", id: string): Promise<string | null> {
  const { data, error } = await serviceClient().from(table).select("tenant_id").eq("id", id).maybeSingle();
  if (error) throw new Error(`${table} read failed: ${error.message}`);
  const t = (data as { tenant_id?: unknown } | null)?.tenant_id;
  return typeof t === "string" ? t : null;
}

async function readRowDefault(decision_id: string): Promise<Row | null> {
  const { data, error } = await serviceClient()
    .from("decisions")
    .select("id, tenant_id, decision_class, body, status, agent_run_id")
    .eq("id", decision_id)
    .maybeSingle();
  if (error) throw new Error(`decision read failed: ${error.message}`);
  return (data as Row | null) ?? null;
}

async function writeDefault(row: Row, advice: { warnings: string[]; at: string }): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(row.tenant_id))
    .from("decisions")
    .update({ founder_advice: advice })
    .eq("id", row.id)
    .eq("tenant_id", row.tenant_id)
    .eq("status", "proposed")
    .select("id");
  if (error) throw new Error(`founder_advice write failed: ${error.message}`);
  return ((data ?? []) as unknown[]).length === 1;
}

async function defaultDeps(): Promise<FounderAdviceDeps> {
  const { evaluateUnattendedAdvisory } = await import("@/services/growth/unattended-policy");
  return {
    readRow: readRowDefault,
    evaluate: (t, a) => evaluateUnattendedAdvisory(t, a),
    write: writeDefault,
    now: () => new Date(),
  };
}

export async function runFounderOrderAdvice(decision_id: string, deps?: FounderAdviceDeps): Promise<FounderAdviceResult> {
  let tenant_id: string | undefined;
  let decision_class: string | undefined;
  try {
    const d = deps ?? (await defaultDeps());
    const row = await d.readRow(decision_id);
    if (!row) return { skipped: "not_found" };
    tenant_id = row.tenant_id;
    decision_class = row.decision_class;
    const origin = (row.body as { origin?: unknown } | null)?.origin;
    if (!isMetaOrGoogleAdClass(row.decision_class) || origin !== "user_initiated_chat") return { skipped: "not_founder_ad" };
    if (row.status !== "proposed") return { skipped: "not_proposed" };
    const warnings = await adviseFounderOrder(row.tenant_id, row.id, row.decision_class, row.body, d.evaluate);
    const written = await d.write(row, { warnings, at: d.now().toISOString() });
    void logEvent({
      level: "info",
      source: "workers/founder-order-advice",
      code: "founder_order.advice_written",
      tenant_id: row.tenant_id,
      meta: { decision_class: row.decision_class, count: warnings.length, changed: written ? 1 : 0 },
    });
    return { written, warnings: warnings.length };
  } catch (e) {
    void logEvent({
      level: "warn",
      source: "workers/founder-order-advice",
      code: "founder_order.advice_failed",
      ...(tenant_id ? { tenant_id } : {}),
      message: `decision ${decision_id}: ${(e as Error).message}`.slice(0, 500),
      ...(decision_class ? { meta: { decision_class } } : {}),
    });
    throw e;
  }
}

async function writeUnavailableDefault(row: Row, advice: { warnings: string[]; at: string; unavailable: true }): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(row.tenant_id))
    .from("decisions")
    .update({ founder_advice: advice })
    .eq("id", row.id)
    .eq("tenant_id", row.tenant_id)
    .eq("status", "proposed")
    .is("founder_advice", null)
    .select("id");
  if (error) throw new Error(`founder_advice write failed: ${error.message}`);
  return ((data ?? []) as unknown[]).length === 1;
}

export async function markFounderAdviceUnavailable(
  decision_id: string,
  deps: { readRow: (id: string) => Promise<Row | null>; write: (row: Row, advice: { warnings: string[]; at: string; unavailable: true }) => Promise<boolean>; now: () => Date } = {
    readRow: readRowDefault,
    write: writeUnavailableDefault,
    now: () => new Date(),
  },
): Promise<boolean> {
  try {
    const row = await deps.readRow(decision_id);
    if (!row || row.status !== "proposed" || !isMetaOrGoogleAdClass(row.decision_class)) return false;
    const written = await deps.write(row, { warnings: [], at: deps.now().toISOString(), unavailable: true });
    void logEvent({ level: "error", source: "workers/founder-order-advice", code: "founder_order.advice_unavailable", tenant_id: row.tenant_id, meta: { decision_class: row.decision_class, changed: written ? 1 : 0 } });
    return written;
  } catch (e) {
    void logEvent({ level: "error", source: "workers/founder-order-advice", code: "founder_order.advice_unavailable_write_failed", message: `decision ${decision_id}: ${(e as Error).message}`.slice(0, 500) });
    return false;
  }
}

export const founderOrderAdviceFn = inngest.createFunction(
  {
    id: "founder-order-advice",
    retries: 2,
    concurrency: [{ key: "event.data.decision_id", limit: 1 }],
    onFailure: async ({ event }) => {
      const id = (event.data as { event?: { data?: { decision_id?: unknown } } }).event?.data?.decision_id;
      if (typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) await markFounderAdviceUnavailable(id);
    },
  },
  { event: "founder_order/advise.requested" },
  async ({ event, step }) => {
    const decision_id = typeof event.data?.decision_id === "string" ? event.data.decision_id : "";
    if (!/^[0-9a-f-]{36}$/i.test(decision_id)) return { skipped: "bad_event" as const };
    return step.run("advise", () => runFounderOrderAdvice(decision_id));
  },
);
