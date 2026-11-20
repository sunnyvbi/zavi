
import { randomUUID } from "node:crypto";
import { cloudflareKv } from "./gateway-kv";
import { loadShardMigrations } from "./migrations";
import { provisionShard, type CreateGuard, type ProvisionResult } from "./provision";
import { shardRegistry } from "./registry";
import { createShardMgmt } from "./shard-mgmt";
import { sealedKvKeyStore, workerSecretKeyStore } from "./shard-keys";
import { signerConfigured } from "./readiness";
import { shardName, type ShardEnv } from "./contract";

type Env = Record<string, string | undefined>;

export const PROVISION_ENV = [
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_MGMT_TOKEN", "SUPABASE_ORG_ID",
  "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_STATIC_API_TOKEN", "CLOUDFLARE_ZONE_ID", "ZAVI_STATIC_KV_NAMESPACE_ID",
  "SITE_AUTH_HOOK_BASE_URL", "SITE_AUTH_BROKER_CALLBACK_URL",
] as const;

export function provisionPrereqsMissing(env: Env = process.env): string[] {
  const v = (k: string) => (env[k] ?? "").trim();
  const out: string[] = PROVISION_ENV.filter((k) => !v(k));
  for (const k of ["SITE_AUTH_HOOK_BASE_URL", "SITE_AUTH_BROKER_CALLBACK_URL"]) {
    if (v(k) && !/^https:\/\//.test(v(k))) out.push(`${k}_not_https`);
  }
  if (!signerConfigured(env)) out.push("signer_not_configured");
  return out;
}

export type ProvisionShardInput = {
  env: ShardEnv;
  n: number;
  region: string;
  canary?: boolean;
  open?: boolean;
  healthPolls?: number;
  log?: (line: string) => void;
};

export class ShardProvisionBusy extends Error {
  constructor(name: string) {
    super(`shard ${name} is being provisioned by another process (job or CLI); retry later`);
    this.name = "ShardProvisionBusy";
  }
}

export class ShardNeedsStaff extends Error {
  constructor(name: string, detail: string) {
    super(`shard ${name} needs staff recovery: ${detail}`);
    this.name = "ShardNeedsStaff";
  }
}

export const PROVISION_LEASE_SECONDS = 40 * 60;
export const CREATE_SETTLE_SECONDS = 10 * 60;

export type GuardRpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;

const defaultRpc: GuardRpc = async (n, a) => (await import("@/services/tenant-client")).siteShardRpc(n, a) as unknown as ReturnType<GuardRpc>;

export type CreateGate = {
  source: "auto" | "staff" | "cli";
  enabled?: () => Promise<boolean>;
  maxPerDay?: () => Promise<number>;
};

export async function withProvisionGuard<T>(
  name: string,
  holder: string,
  gate: CreateGate,
  fn: (guard: CreateGuard) => Promise<T>,
  rpc: GuardRpc = defaultRpc,
): Promise<T> {
  const h = `${holder.slice(0, 120)}:${randomUUID()}`;
  const call = async (fnName: string, args: Record<string, unknown>) => {
    const r = await rpc(fnName, args);
    if (r.error) throw new Error(`${fnName} failed: ${r.error.message ?? "unknown"}`);
    return r.data;
  };
  const got = (await call("site_shard_guard_acquire", { p_name: name, p_holder: h, p_seconds: PROVISION_LEASE_SECONDS })) as { ok?: boolean; reason?: string; detail?: string };
  if (!got?.ok) {
    if (got?.reason === "busy") throw new ShardProvisionBusy(name);
    throw new ShardNeedsStaff(name, got?.reason === "stale_lease" ? `its lease expired while held by ${got.detail ?? "another process"} (a create may have been in flight)` : String(got?.detail ?? got?.reason ?? "unknown"));
  }
  const guard: CreateGuard = {
    async beginCreate() {
      const [enabled, max] = await Promise.all([gate.enabled ? gate.enabled() : Promise.resolve(true), gate.maxPerDay ? gate.maxPerDay() : Promise.resolve(10)]);
      const r = (await call("site_shard_guard_begin_create", {
        p_name: name, p_holder: h, p_source: gate.source, p_enabled: enabled, p_max_per_day: max, p_settle_seconds: CREATE_SETTLE_SECONDS,
      })) as { ok?: boolean; reason?: string; detail?: string };
      return r?.ok ? { ok: true } : { ok: false, reason: String(r?.reason ?? "refused"), ...(r?.detail ? { detail: String(r.detail) } : {}) };
    },
    async endCreate(outcome) {
      await call("site_shard_guard_end_create", { p_name: name, p_holder: h, p_outcome: outcome });
    },
  };
  try {
    return await fn(guard);
  } finally {
    await Promise.resolve(call("site_shard_guard_release", { p_name: name, p_holder: h })).catch(() => undefined);
  }
}

export async function runProvisionShard(input: ProvisionShardInput & { holder?: string; gate?: CreateGate }): Promise<ProvisionResult> {
  if (!Number.isInteger(input.n) || input.n < 1) throw new Error("runProvisionShard: n must be a positive integer");
  return withProvisionGuard(shardName(input.env, input.n), input.holder ?? "cli", input.gate ?? { source: "cli" }, (guard) => provisionUnderLease(input, guard));
}

async function provisionUnderLease(input: ProvisionShardInput, createGuard: CreateGuard): Promise<ProvisionResult> {
  const kv = cloudflareKv();
  const kek = (process.env.SITE_SIGNER_KEK_PUBLIC_JWK ?? "").trim();
  const signer = kek ? sealedKvKeyStore({ kv, kekPublicJwk: () => JSON.parse(kek) }) : workerSecretKeyStore();
  const registry = shardRegistry();
  return provisionShard(
    {
      registry,
      mgmt: createShardMgmt(),
      files: loadShardMigrations(),
      hookBaseUrl: (process.env.SITE_AUTH_HOOK_BASE_URL ?? "").trim(),
      secrets: registry,
      brokerCallbackUrl: (process.env.SITE_AUTH_BROKER_CALLBACK_URL ?? "").trim(),
      signer,
      kv,
      log: input.log ?? console.warn,
      createGuard,
      ...(input.healthPolls ? { healthPolls: input.healthPolls } : {}),
    },
    { env: input.env, n: input.n, region: input.region, canary: input.canary, open: input.open !== false },
  );
}
