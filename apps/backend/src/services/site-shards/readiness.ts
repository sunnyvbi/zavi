
import type { SiteStarterProvider } from "@/services/sites/contract";
import { staticHostingConfig } from "@/services/hosting/static-publish";
import { siteAuthConfigured } from "@/services/site-auth";
import type { ShardEnv } from "./contract";
import type { ShardPlacementReadiness } from "./registry";
import { GATEWAY_WORKER_ENV } from "./gateway-route";

type Env = Record<string, string | undefined>;

export function signerConfigured(env: Env = process.env): boolean {
  const kek = (env.SITE_SIGNER_KEK_PUBLIC_JWK ?? "").trim();
  if (kek) {
    try {
      const j = JSON.parse(kek) as Record<string, unknown>;
      return j.kty === "EC" && j.crv === "P-256" && typeof j.x === "string" && typeof j.y === "string" && typeof j.kid === "string" && !!j.kid && !("d" in j);
    } catch {
      return false;
    }
  }
  return ["CLOUDFLARE_ACCOUNT_ID", "SITE_SIGNER_WORKER_NAME", "CLOUDFLARE_SIGNER_API_TOKEN"].every((k) => !!(env[k] ?? "").trim());
}

export function gatewayConfigured(env: Env = process.env): boolean {
  return staticHostingConfig(env).ok && !!(env[GATEWAY_WORKER_ENV] ?? "").trim();
}

function starterProblem(s: SiteStarterProvider | null): string | null {
  if (!s) return "starter_not_wired";
  try {
    s.starterFiles();
    return null;
  } catch {
    return "starter_lockfile_missing";
  }
}

export function missingPrerequisites(
  seams: { manifest: unknown; auth: unknown; starter: SiteStarterProvider | null },
  env: Env = process.env,
): string[] {
  const out: string[] = [];
  if (!seams.manifest) out.push("manifest_not_wired");
  if (!seams.auth) out.push("auth_broker_not_wired");
  if (!siteAuthConfigured(env as NodeJS.ProcessEnv)) out.push("broker_secrets_missing");
  if (!signerConfigured(env)) out.push("signer_not_configured");
  if (!gatewayConfigured(env)) out.push("gateway_not_configured");
  const sp = starterProblem(seams.starter);
  if (sp) out.push(sp);
  return out;
}

export type PooledReadinessDeps = {
  env: () => Env;
  seams: () => { manifest: unknown; auth: unknown; starter: SiteStarterProvider | null };
  shardEnv: () => ShardEnv;
  placement: (env: ShardEnv) => Promise<ShardPlacementReadiness>;
  requestMetricsSweep?: (env: ShardEnv) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  alert?: (msg: string) => Promise<void>;
  openShardTtlMs?: number;
  sweepRequestGapMs?: number;
};

export type PooledReadiness = {
  enabledFor(tenant_id: string): Promise<boolean>;
  reasons(): Promise<string[]>;
};

export function placementProblem(p: ShardPlacementReadiness, env: ShardEnv): string | null {
  if (p.placeable > 0) return null;
  if (p.open === 0) return `no_open_shard_${env}`;
  if (p.stale > 0) return `shard_metrics_stale_${env}`;
  if (p.paused > 0) return `shard_placement_paused_${env}`;
  return `no_shard_capacity_${env}`;
}

export function createPooledReadiness(deps: PooledReadinessDeps): PooledReadiness {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l: string) => console.warn(l));
  const ttl = deps.openShardTtlMs ?? 60_000;
  const sweepGap = deps.sweepRequestGapMs ?? 60_000;
  let shardCache: { env: ShardEnv; at: number; reason: string } | null = null;
  let lastState: string | null = null;
  let lastSweepAsk: number | null = null;

  function askSweep(env: ShardEnv): void {
    const request = deps.requestMetricsSweep;
    if (!request) return;
    if (lastSweepAsk !== null && now() - lastSweepAsk < sweepGap) return;
    lastSweepAsk = now();
    void Promise.resolve()
      .then(() => request(env))
      .then(() => log(`[site-shards] open ${env} shards have stale metrics: asked for an immediate metrics sweep`))
      .catch((e: unknown) => log(`[site-shards] metrics sweep request failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`));
  }

  async function placeable(): Promise<string | null> {
    const env = deps.shardEnv();
    if (shardCache && shardCache.env === env && now() - shardCache.at < ttl) return shardCache.reason;
    let p: ShardPlacementReadiness;
    try {
      p = await deps.placement(env);
    } catch {
      return "shard_registry_unreadable";
    }
    const problem = placementProblem(p, env);
    shardCache = problem === `no_open_shard_${env}` || problem === `no_shard_capacity_${env}` ? { env, at: now(), reason: problem } : null;
    if (problem === `shard_metrics_stale_${env}`) askSweep(env);
    return problem;
  }

  async function reasons(): Promise<string[]> {
    const missing = missingPrerequisites(deps.seams(), deps.env());
    if (missing.length) return missing;
    const problem = await placeable();
    return problem ? [problem] : [];
  }

  function record(r: string[]): void {
    const state = r.length ? r.join(",") : "ready";
    if (state === lastState) return;
    const first = lastState === null;
    lastState = state;
    if (!r.length) {
      if (!first) log("[site-shards] pooled backend: ready again (new website builds start)");
      return;
    }
    const line = `pooled backend unavailable (${state}); new website builds fail (retryable) until fixed`;
    log(`[site-shards] ${line}`);
    void Promise.resolve()
      .then(() => deps.alert?.(line))
      .catch(() => undefined);
  }

  return {
    async enabledFor(_tenant_id) {
      let r: string[];
      try {
        r = await reasons();
      } catch {
        r = ["readiness_check_failed"];
      }
      record(r);
      return r.length === 0;
    },
    reasons,
  };
}
