
import {
  asTenantId,
  globalClient,
  tenantRpc,
  type TenantId,
} from "@/services/tenant-client";
import type { AgentTrigger } from "../types";
import type { SteerMsg, SteerSource } from "./types";

const LEASE_SECONDS = 30;
const MARK_RETRIES = 3;
const MARK_RETRY_MS = 150;

interface SteerRow {
  id: string;
  seq: number | string;
  body: string;
  origin: string;
  author_user_id: string | null;
}

const STEERABLE_ORIGINS: ReadonlySet<string> = new Set([
  "chat",
  "slack",
  "email",
  "teams",
]);

export async function isBargeInEnabledForTenant(
  tenantId: string,
): Promise<boolean> {
  try {
    const { data, error } = await globalClient()
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    if (blob.agent_barge_in_enabled !== true) return false;
    const disabled = blob.agent_barge_in_disabled_tenants;
    if (Array.isArray(disabled) && disabled.includes(tenantId)) return false;
    return true;
  } catch {
    return false;
  }
}

export class DbSteerSource implements SteerSource {
  private readonly runId: string;
  private readonly tid: TenantId;

  constructor(opts: { runId: string; tenantId: TenantId }) {
    this.runId = opts.runId;
    this.tid = opts.tenantId;
  }

  async drain(afterSeq: number, max: number): Promise<SteerMsg[]> {
    const { data, error } = await tenantRpc(this.tid, "drain_agent_run_steers", {
      p_run_id: this.runId,
      p_after_seq: afterSeq,
      p_max: max,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (error) throw new Error(`drain_agent_run_steers: ${error.message}`);
    const rows = (data ?? []) as SteerRow[];
    return rows
      .map((r) => ({
        id: r.id,
        seq: Number(r.seq),
        body: r.body,
        origin: (STEERABLE_ORIGINS.has(r.origin)
          ? r.origin
          : "chat") as SteerMsg["origin"],
        author_user_id: r.author_user_id,
      }))
      .filter((s) => Number.isFinite(s.seq));
  }

  async markDrained(ids: string[], _turn: number): Promise<void> {
    if (ids.length === 0) return;
    let lastErr = "";
    for (let attempt = 0; attempt < MARK_RETRIES; attempt++) {
      const { error } = await tenantRpc(
        this.tid,
        "mark_agent_run_steers_drained",
        { p_ids: ids, p_run_id: this.runId },
      );
      if (!error) return;
      lastErr = error.message;
      if (attempt < MARK_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, MARK_RETRY_MS * (attempt + 1)));
      }
    }
    throw new Error(`mark_agent_run_steers_drained: ${lastErr}`);
  }
}

export async function resolveSteerSourceForRun(opts: {
  runId: string;
  tenantId: string;
  trigger: AgentTrigger;
  batchId?: string | null;
  isShadowRun?: boolean;
}): Promise<SteerSource | undefined> {
  if (opts.isShadowRun) return undefined;
  if (!STEERABLE_ORIGINS.has(opts.trigger)) return undefined;
  if (opts.batchId != null) return undefined;
  if (!opts.runId || !opts.tenantId) return undefined;
  const enabled = await isBargeInEnabledForTenant(opts.tenantId);
  if (!enabled) return undefined;
  return new DbSteerSource({
    runId: opts.runId,
    tenantId: asTenantId(opts.tenantId),
  });
}
