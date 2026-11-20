import { createRequire } from "node:module";
import { platformRefs } from "../../shard-mgmt";
import type { ShardTarget } from "./target";
import { SHARD_REF_RE } from "./target";

const req = createRequire(__filename);

function need(env: NodeJS.ProcessEnv, k: string): string {
  const v = (env[k] ?? "").trim();
  if (!v) throw new Error(`hosted isolation gate: ${k} is required`);
  return v;
}

function assertDbUrlOf(name: string, raw: string, ref: string, role: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${name} is not a connection URL`);
  }
  for (const k of u.searchParams.keys()) if (k !== "sslmode") throw new Error(`${name} carries a '${k}' parameter: refused`);
  const { parse } = req("pg-connection-string") as { parse(s: string): { host?: string | null; user?: string } };
  const c = parse(raw);
  const host = String(c.host ?? "");
  const user = String(c.user ?? "");
  const direct = host === `db.${ref}.supabase.co` && user === role;
  const pooled = /\.pooler\.supabase\.com$/.test(host) && user === `${role}.${ref}`;
  if (!direct && !pooled) throw new Error(`${name} does not connect as ${role} to project ${ref}: refused`);
}

function shardFrom(env: NodeJS.ProcessEnv, p: string, kind: ShardTarget["kind"], forbidden: Set<string>): ShardTarget {
  const ref = need(env, `${p}REF`);
  if (!SHARD_REF_RE.test(ref)) throw new Error(`${p}REF is not a project ref`);
  if (forbidden.has(ref)) throw new Error(`${p}REF is one of Zavi's own (production/staging platform) projects: refused`);
  const signerJwk = JSON.parse(need(env, `${p}SIGNER_JWK`)) as Record<string, unknown>;
  if (signerJwk.kty !== "EC" || signerJwk.crv !== "P-256" || typeof signerJwk.d !== "string" || typeof signerJwk.kid !== "string") {
    throw new Error(`${p}SIGNER_JWK must be a private EC P-256 JWK with a kid`);
  }
  const adminDbUrl = need(env, `${p}DB_URL`);
  const brokerDbUrl = need(env, `${p}BROKER_DB_URL`);
  for (const [k, url] of [["DB_URL", adminDbUrl], ["BROKER_DB_URL", brokerDbUrl]] as const) {
    let decoded = url;
    try {
      decoded = decodeURIComponent(url);
    } catch {
      throw new Error(`${p}${k} is not a valid URL`);
    }
    for (const bad of forbidden) if (decoded.includes(bad)) throw new Error(`${p}${k} points at one of Zavi's own projects: refused`);
  }
  assertDbUrlOf(`${p}DB_URL`, adminDbUrl, ref, "postgres");
  assertDbUrlOf(`${p}BROKER_DB_URL`, brokerDbUrl, ref, "zsite_broker");
  return {
    ref,
    kind,
    publicUrl: `https://${ref}.supabase.co`,
    baseUrl: `https://${ref}.supabase.co`,
    publishableKey: need(env, `${p}PUBLISHABLE_KEY`),
    anonKey: need(env, `${p}PUBLISHABLE_KEY`),
    serviceKey: need(env, `${p}SERVICE_KEY`),
    adminDbUrl,
    brokerDbUrl,
    hookSecret: need(env, `${p}HOOK_SECRET`),
    signerJwk,
  };
}

export function hostedShards(env: NodeJS.ProcessEnv): { pooled: ShardTarget; kernel: ShardTarget } {
  if (env.ZSI_HOSTED_ENV !== "staging") throw new Error("hosted isolation gate: ZSI_HOSTED_ENV=staging is required (never production)");
  const forbidden = platformRefs(env);
  const pooled = shardFrom(env, "ZSI_POOLED_", "pooled", forbidden);
  const kernel = shardFrom(env, "ZSI_KERNEL_", "kernel", forbidden);
  if (pooled.ref === kernel.ref) throw new Error("the kernel shard must be a different project from the pooled shard");
  const confirm = (env.ZSI_HOSTED_CONFIRM ?? "").split(",").map((s) => s.trim());
  if (confirm.length !== 2 || confirm[0] !== pooled.ref || confirm[1] !== kernel.ref) {
    throw new Error("hosted isolation gate: ZSI_HOSTED_CONFIRM must be '<pooled ref>,<kernel ref>'");
  }
  return { pooled, kernel };
}

export const STAGING_PLATFORM_REF = "dgzgwclslzzzrjopbobp";

export interface RegistryRow {
  env?: string | null;
  state?: string | null;
  purpose?: string | null;
  dedicated_site_id?: string | null;
}

export function registryRefusal(ref: string, rows: RegistryRow[] | null): string | null {
  if (!Array.isArray(rows) || rows.length !== 1) return `shard ${ref} is not registered in the staging shard registry`;
  const r = rows[0];
  if (r.env !== "dev") return `shard ${ref} is registered for env ${r.env}`;
  if (r.purpose !== "validation") return `shard ${ref} is a '${r.purpose ?? "unknown"}' shard, not a validation shard (placement could put a customer on it)`;
  if (r.state === "open" || r.state === "retired" || r.state === "provisioning" || !r.state) return `shard ${ref} is in state ${r.state}`;
  if (r.dedicated_site_id) return `shard ${ref} is a site's dedicated project`;
  return null;
}

export async function assertRegisteredAsStagingShards(shards: ShardTarget[], env: NodeJS.ProcessEnv): Promise<void> {
  let host = "";
  try {
    host = new URL(String(env.SUPABASE_URL ?? "")).hostname;
  } catch {
    host = "";
  }
  if (host !== `${STAGING_PLATFORM_REF}.supabase.co`) throw new Error("hosted isolation gate: SUPABASE_URL must be the staging Zavi project (its shard registry vouches for the shards)");
  const key = need(env, "SUPABASE_SERVICE_ROLE_KEY");
  for (const sh of shards) {
    const res = await fetch(`https://${host}/rest/v1/site_shards?project_ref=eq.${sh.ref}&select=env,state,purpose,dedicated_site_id`, {
      headers: { apikey: key, authorization: `Bearer ${key}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`staging shard registry read failed (${res.status}) for ${sh.ref}: refused`);
    const why = registryRefusal(sh.ref, (await res.json().catch(() => null)) as RegistryRow[] | null);
    if (why) throw new Error(`hosted isolation gate: ${why}: refused`);
  }
}

export async function assertHostedShardsAreScratch(shards: ShardTarget[]): Promise<void> {
  const { Client } = req("pg") as typeof import("pg");
  for (const sh of shards) {
    const c = new Client({ connectionString: sh.adminDbUrl });
    await c.connect();
    try {
      const shape = await c.query("select to_regclass('zsite.sites') is not null as shard");
      if (shape.rows[0].shard !== true) throw new Error(`database for ${sh.ref} is not a site shard: refused`);
      const r = await c.query("select count(*)::int as n from zsite.sites");
      if (r.rows[0].n > 0) throw new Error(`shard ${sh.ref} already holds ${r.rows[0].n} site(s): refused (use an empty staging shard)`);
    } finally {
      await c.end();
    }
  }
}
