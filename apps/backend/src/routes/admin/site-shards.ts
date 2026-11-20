
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { writeStaffAudit, writeStaffAuditStrict } from "@/services/staff/audit";
import {
  staffRecover,
  type RecoveryDeps,
  envHeadroom,
  isPooledShard,
  isValidationShard,
  normalizeSettings,
  requestProvision,
  shardLoad,
  type AutoProvStore,
  type CheckDeps,
  type ShardLoadRow,
} from "@/services/site-shards/autoprovision";

export const ProvisionBody = z
  .object({
    override_cap: z.boolean().optional(),
    reason: z.string().trim().min(3).max(200).optional(),
  })
  .strict()
  .refine((b) => !b.override_cap || !!b.reason, { message: "override_cap needs a reason" });

export const PauseBody = z.object({ paused: z.boolean(), reason: z.string().trim().max(200).optional() }).strict();

type Deps = CheckDeps & { store: AutoProvStore };
let recoveryOverride: RecoveryDeps | null = null;
export function _setRecoveryDeps(d: RecoveryDeps | null): void {
  recoveryOverride = d;
}
export const RecoverBody = z.object({ shard_name: z.string().regex(/^zavi-shard-(prod|dev)-[0-9]{1,6}$/) }).strict();

let depsOverride: Deps | null = null;
export function _setSiteShardsDeps(d: Deps | null): void {
  depsOverride = d;
}
async function deps(): Promise<Deps> {
  if (depsOverride) return depsOverride;
  const { productionCheckDeps } = await import("@/services/site-shards/autoprovision");
  return productionCheckDeps();
}

function fail(res: Response, e: unknown): void {
  res.status(500).json({ error: { code: "site_shards_failed", message: String((e as Error)?.message ?? e).slice(0, 300) } });
}

const METRIC_KEYS = [
  "m_records", "m_bytes", "m_requests_per_min", "m_p95_ms", "m_cpu_pct", "m_connections", "m_auth_users", "m_sessions", "m_emails_per_hour",
] as const;

export async function staffSiteShardsList(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  try {
    const d = await deps();
    const [rows, status, settings] = await Promise.all([d.listShards(d.env), d.store.status(d.env, 20), d.settings()]);
    const { open, headroom } = envHeadroom(rows);
    res.json({
      env: d.env,
      deployed_backend: d.allowed().ok,
      settings: normalizeSettings(settings),
      headroom,
      open,
      auto: status.state,
      day: status.day,
      created_today: status.created_today,
      attempts: status.ledger,
      prereqs_missing: d.prereqsMissing(),
      shards: rows
        .filter((s) => isPooledShard(s) || isValidationShard(s))
        .map((row) => (s => ({
          id: s.id,
          name: s.name,
          purpose: s.purpose ?? "pool",
          state: s.state,
          project_ref: s.project_ref,
          region: s.region ?? null,
          is_canary: s.is_canary ?? false,
          provision_step: s.provision_step ?? null,
          schema_version: s.schema_version ?? null,
          site_count: s.site_count,
          max_sites: s.max_sites,
          fill_ratio: s.fill_ratio ?? null,
          load: shardLoad(s),
          soft_full_at: s.soft_full_at ?? null,
          metrics: Object.fromEntries(METRIC_KEYS.map((k) => [k.slice(2), s[k] ?? null])),
          metrics_at: s.metrics_at ?? null,
        }))(row as ShardLoadRow & Record<string, unknown>)),
    });
  } catch (e) {
    fail(res, e);
  }
}

const STATUS: Record<string, number> = {
  not_deployed_backend: 409,
  prereqs_missing: 409,
  in_progress_manual: 409,
  backoff: 409,
  paused: 409,
  cap: 429,
};

export async function staffSiteShardsProvision(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const parsed = ProvisionBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  const override = parsed.data.override_cap === true;
  try {
    const d = await deps();
    if (override) {
      await writeStaffAuditStrict({
        actor_user_id: staff.user_id,
        actor_email: staff.email,
        action: "site_shards.provision_cap_override",
        target_table: "site_shard_autoprov",
        target_id: d.env,
        meta: { reason: parsed.data.reason },
      });
    }
    const r = await requestProvision(d, { actor: staff.email || staff.user_id, override });
    await writeStaffAudit({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "site_shards.provision",
      target_table: "site_shards",
      target_id: d.env,
      meta: { result: r.ok ? r.action : r.code, shard: r.ok && "shard_name" in r ? r.shard_name : null, override_cap: override, reason: parsed.data.reason ?? null },
    });
    if (!r.ok) {
      res.status(STATUS[r.code] ?? 409).json({ error: { code: r.code, message: r.message } });
      return;
    }
    res.status(202).json({ env: d.env, ...r });
  } catch (e) {
    fail(res, e);
  }
}

export async function staffSiteShardsAutoProvisioning(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const parsed = PauseBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  try {
    const d = await deps();
    const state = await d.store.setPaused(d.env, parsed.data.paused, staff.email || staff.user_id, parsed.data.reason ?? null);
    await writeStaffAudit({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: parsed.data.paused ? "site_shards.auto_pause" : "site_shards.auto_resume",
      target_table: "site_shard_autoprov",
      target_id: d.env,
      meta: { reason: parsed.data.reason ?? null },
    });
    await d
      .alert(
        parsed.data.paused ? "sites.shards.auto_paused" : "sites.shards.auto_resumed",
        `auto-provisioning ${parsed.data.paused ? "PAUSED" : "resumed"} by staff ${staff.email || staff.user_id} (${d.env})${parsed.data.reason ? `: ${parsed.data.reason}` : ""}`,
      )
      .catch(() => undefined);
    res.json({ env: d.env, auto: state });
  } catch (e) {
    fail(res, e);
  }
}

export async function staffSiteShardsRecover(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const parsed = RecoverBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  try {
    const d = recoveryOverride ?? (await (await import("@/services/site-shards/autoprovision")).productionRecoveryDeps());
    const r = await staffRecover(d, parsed.data.shard_name, staff.email || staff.user_id);
    await writeStaffAudit({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "site_shards.recover",
      target_table: "site_shard_provision_guards",
      target_id: parsed.data.shard_name,
      meta: r.ok ? { outcome: r.outcome, ref: r.outcome === "adopted" ? r.ref : null } : { refused: r.code },
    });
    if (!r.ok) {
      res.status(r.code === "bad_name" ? 400 : 409).json({ error: { code: r.code, message: r.message } });
      return;
    }
    res.json(r);
  } catch (e) {
    fail(res, e);
  }
}
