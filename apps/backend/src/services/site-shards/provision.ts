
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  PROVISION_DONE,
  shardKvKey,
  shardName,
  type ShardAuthHooks,
  type ShardSecretName,
  type ShardEnv,
  type ShardRow,
} from "./contract";
import { applyPendingMigrations, latestVersion, type ShardMigrationFile } from "./migrations";
import type { ShardRegistry, ShardSecretStore } from "./registry";
import type { ShardMgmt } from "./shard-mgmt";
import { shardKeySecretName, type ShardKeyStore } from "./shard-keys";
import type { KvStore } from "./gateway-kv";
import { BROKER_ROLE_TIMEOUT_SQL, brokerDbUrl, isPooledBrokerDbUrl, repairShardBrokerDbUrl } from "./broker-db-url";

export const PROVISION_STEPS = [
  "registered", "project", "healthy", "schema", "data_api", "graphql_off", "broker", "auth_config", "signing_key", "gateway_kv",
  PROVISION_DONE,
] as const;
export type ProvisionStep = (typeof PROVISION_STEPS)[number];

export const SHARD_AUTH_RATE_LIMITS = {
  rate_limit_email_sent: 100_000,
  rate_limit_otp: 100_000,
  rate_limit_verify: 100_000,
  rate_limit_token_refresh: 100_000,
} as const;

export const SHARD_JWT_EXP_SECONDS = 300;

export const signerSecretName = shardKeySecretName;
export const signingKidPrefix = (shard_id: string) => `zavi-gw-${shard_id.slice(0, 8)}`;

export const SIGNING_KID_SLOTS = 64;

export function shardSigningKid(shard_id: string, n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= SIGNING_KID_SLOTS) throw new Error("signing kid slot out of range");
  const h = createHash("sha256").update(`zavi-shard-signing-kid|v1|${shard_id}|${n}`).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export function isZaviSigningKid(shard_id: string, kid: string | null | undefined): boolean {
  if (!kid) return false;
  if (kid.startsWith(`${signingKidPrefix(shard_id)}-`)) return true;
  for (let n = 0; n < SIGNING_KID_SLOTS; n++) if (shardSigningKid(shard_id, n) === kid) return true;
  return false;
}

export function nextSigningKid(shard_id: string, presentKids: Iterable<string | null>): string | null {
  const present = new Set<string>();
  for (const k of presentKids) if (k) present.add(k);
  for (let n = 0; n < SIGNING_KID_SLOTS; n++) {
    const kid = shardSigningKid(shard_id, n);
    if (!present.has(kid)) return kid;
  }
  return null;
}

export type CreateGuard = {
  beginCreate(): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;
  endCreate(outcome: "created" | "definite" | "ambiguous"): Promise<void>;
};

export function isDefiniteCreateRefusal(e: unknown): boolean {
  const err = e as { name?: string; status?: number; message?: string } | null;
  if (err?.name === "SupabaseMgmtError") return [400, 401, 403, 404, 422].includes(Number(err.status));
  return /^invalid region$/.test(String(err?.message ?? ""));
}

export type ProvisionDeps = {
  registry: ShardRegistry;
  mgmt: ShardMgmt;
  files: ShardMigrationFile[];
  hookBaseUrl: string;
  secrets: ShardSecretStore;
  brokerCallbackUrl: string;
  signer: ShardKeyStore | null;
  kv: KvStore;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  generateJwk?: (kid: string) => Record<string, unknown>;
  log?: (line: string) => void;
  healthPolls?: number;
  createGuard?: CreateGuard;
};

export type ProvisionResult =
  | { status: "open" | "ready"; shard: ShardRow }
  | { status: "blocked"; shard: ShardRow; step: ProvisionStep; reason: string };

function es256Jwk(kid: string): Record<string, unknown> {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { ...jwk, kid, alg: "ES256", use: "sig" };
}

function assertCallback(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("broker callback URL is not a URL");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.hostname.includes("*")) {
    throw new Error("broker callback URL must be one fixed https URL");
  }
  return u.toString();
}

export function shardAuthHooks(hookBaseUrl: string, project_ref: string, hookSecret: string): ShardAuthHooks {
  const base = new URL(hookBaseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("hook base URL must be a plain https origin");
  }
  return {
    hook_custom_access_token_enabled: true,
    hook_custom_access_token_uri: "pg-functions://postgres/zsite_auth/custom_access_token_hook",
    hook_send_email_enabled: true,
    hook_send_email_uri: `${base.origin}/api/public/site-auth/hooks/send-email/${project_ref}`,
    hook_send_email_secrets: hookSecret,
  };
}

export { brokerDbUrl };

const done = (shard: ShardRow, step: ProvisionStep) =>
  PROVISION_STEPS.indexOf((shard.provision_step ?? "") as ProvisionStep) >= PROVISION_STEPS.indexOf(step);

export async function provisionShard(
  deps: ProvisionDeps,
  input: { env: ShardEnv; n: number; region: string; canary?: boolean; open?: boolean } | { kernel: ShardRow },
): Promise<ProvisionResult> {
  const log = deps.log ?? (() => undefined);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const callback = assertCallback(deps.brokerCallbackUrl);
  const kernel = "kernel" in input ? input.kernel : null;
  if (kernel && (!kernel.project_ref || !/-k[0-9a-f]{32}$/.test(kernel.name))) throw new Error("provision: not a kernel shard row");
  const name = kernel ? kernel.name : shardName((input as { env: ShardEnv }).env, (input as { n: number }).n);
  const opts = kernel ? { open: false } : (input as { open?: boolean });

  let shard = kernel ?? (await deps.registry.register({ env: (input as { env: ShardEnv }).env, name, region: (input as { region: string }).region, is_canary: (input as { canary?: boolean }).canary }));
  if (shard.state === "retired") throw new Error(`shard ${name} is retired`);
  const mark = async (step: ProvisionStep, extra: Record<string, unknown> = {}) => {
    if (done(shard, step) && !Object.keys(extra).length) return;
    shard = await deps.registry.update(shard.id, { ...(done(shard, step) ? {} : { provision_step: step }), ...extra });
    log(`[shard-provision] ${name}: ${step}`);
  };
  await mark("registered");

  if (!shard.project_ref) {
    const guard = deps.createGuard;
    const found = await deps.mgmt.listProjectsByName(name);
    if (found.length > 1) {
      if (guard) return { status: "blocked", shard, step: "project", reason: `guard:duplicates: ${found.length} projects named ${name}; delete the extras by hand, then recover` };
      throw new Error(`more than one project named ${name}; resolve by hand`);
    }
    if (found[0]) {
      await mark("project", { project_ref: found[0].ref, url: `https://${found[0].ref}.supabase.co` });
      await guard?.endCreate("created");
    } else {
      if (guard) {
        const b = await guard.beginCreate();
        if (!b.ok) return { status: "blocked", shard, step: "project", reason: `guard:${b.reason}${b.detail ? `: ${b.detail}` : ""}` };
      }
      let project: { ref: string };
      try {
        project = await deps.mgmt.createProject({ name, dbPass: randomBytes(32).toString("base64url"), region: (input as { region: string }).region });
      } catch (e) {
        const definite = isDefiniteCreateRefusal(e);
        await guard?.endCreate(definite ? "definite" : "ambiguous");
        if (guard && !definite) {
          return { status: "blocked", shard, step: "project", reason: `guard:uncertain: the create response was lost (${String((e as Error)?.message ?? e).slice(0, 120)}); reconciling by name after the settle period` };
        }
        throw e;
      }
      await mark("project", { project_ref: project.ref, url: `https://${project.ref}.supabase.co` });
      await guard?.endCreate("created");
    }
  } else {
    await mark("project");
  }
  const ref = shard.project_ref as string;

  if (!done(shard, "healthy")) {
    let healthy = false;
    for (let i = 0; i < (deps.healthPolls ?? 90) && !healthy; i++) {
      healthy = await deps.mgmt.isHealthy(ref).catch(() => false);
      if (!healthy) await sleep(10_000);
    }
    if (!healthy) return { status: "blocked", shard, step: "healthy", reason: "project is not healthy yet; re-run later" };
    await mark("healthy");
  }

  const applied = await applyPendingMigrations(deps.mgmt, ref, deps.files, { checksums: { shard_id: shard.id, store: deps.registry } });
  if (applied.failed) {
    return { status: "blocked", shard, step: "schema", reason: `${applied.failed.version}: ${applied.failed.error}` };
  }
  const latest = latestVersion(deps.files);
  await mark("schema", latest && shard.schema_version !== latest ? { schema_version: latest } : {});

  if ((await deps.mgmt.getExposedSchemas(ref)).replace(/\s/g, "") !== "api") {
    await deps.mgmt.setExposedSchemas(ref, "api");
    if ((await deps.mgmt.getExposedSchemas(ref)).replace(/\s/g, "") !== "api") {
      return { status: "blocked", shard, step: "data_api", reason: "exposed schemas did not read back as api" };
    }
  }
  await mark("data_api");

  await deps.mgmt.query(ref, "drop extension if exists pg_graphql");
  const gql = (await deps.mgmt.query(ref, "select count(*)::int as n from pg_extension where extname = 'pg_graphql'")) as Array<{ n?: number }>;
  if (Number(gql[0]?.n ?? 1) !== 0) return { status: "blocked", shard, step: "graphql_off", reason: "pg_graphql is still installed" };
  await mark("graphql_off");

  const secret = (n: ShardSecretName) => deps.secrets.getSecret(shard.id, n);
  const keys = await deps.mgmt.apiKeys(ref);
  if ((await secret("service_key")) !== keys.service_role) await deps.secrets.setSecret(shard.id, "service_key", keys.service_role);
  if ((await secret("anon_key")) !== keys.anon) await deps.secrets.setSecret(shard.id, "anon_key", keys.anon);
  let hookSecret = await secret("hook_secret");
  if (!hookSecret) {
    hookSecret = `v1,whsec_${randomBytes(32).toString("base64")}`;
    await deps.secrets.setSecret(shard.id, "hook_secret", hookSecret);
  }
  const storedBrokerUrl = await secret("broker_db_url");
  if (!done(shard, "broker") || !storedBrokerUrl) {
    const role = (await deps.mgmt.query(ref, "select count(*)::int as n from pg_roles where rolname = 'zsite_broker'")) as Array<{ n?: number }>;
    if (Number(role[0]?.n ?? 0) !== 1) return { status: "blocked", shard, step: "broker", reason: "role zsite_broker is missing (S3's 1002_broker.sql)" };
    let poolerHost: string;
    try {
      poolerHost = await deps.mgmt.poolerHost(ref);
    } catch (e) {
      return { status: "blocked", shard, step: "broker", reason: `the project's pooler host is unavailable: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
    }
    const pw = randomBytes(32).toString("base64url");
    await deps.mgmt.query(ref, `alter role zsite_broker with login password '${pw}'`);
    await deps.mgmt.query(ref, BROKER_ROLE_TIMEOUT_SQL);
    await deps.secrets.setSecret(shard.id, "broker_db_url", brokerDbUrl(ref, pw, poolerHost));
  } else if (!isPooledBrokerDbUrl(storedBrokerUrl, ref)) {
    try {
      await repairShardBrokerDbUrl({ secrets: deps.secrets, mgmt: deps.mgmt, log }, shard);
    } catch (e) {
      return { status: "blocked", shard, step: "broker", reason: `broker_db_url could not be moved to the pooler: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
    }
  } else {
    await deps.mgmt.query(ref, BROKER_ROLE_TIMEOUT_SQL);
  }
  await mark("broker");

  if (!/^https:\/\//.test(deps.hookBaseUrl ?? "")) {
    return { status: "blocked", shard, step: "auth_config", reason: "the Send Email Hook base URL is not configured" };
  }
  const desiredAuth: Record<string, unknown> = {
    ...shardAuthHooks(deps.hookBaseUrl, ref, hookSecret),
    site_url: callback,
    uri_allow_list: callback,
    external_email_enabled: true,
    jwt_exp: SHARD_JWT_EXP_SECONDS,
    ...SHARD_AUTH_RATE_LIMITS,
  };
  await deps.mgmt.patchAuthConfig(ref, desiredAuth);
  const auth = await deps.mgmt.getAuthConfig(ref);
  const authProblems = [
    auth.external_email_enabled !== true && "email auth is off",
    auth.hook_send_email_enabled !== true && "Send Email Hook is not enabled",
    auth.hook_custom_access_token_enabled !== true && "custom access token hook is not enabled",
    auth.hook_send_email_uri !== desiredAuth.hook_send_email_uri && "Send Email Hook points elsewhere",
    auth.hook_custom_access_token_uri !== desiredAuth.hook_custom_access_token_uri && "access token hook points elsewhere",
    auth.uri_allow_list !== callback && "redirect allowlist is not exactly the broker callback",
    auth.site_url !== callback && "site_url is not the broker callback",
    Number(auth.jwt_exp) !== SHARD_JWT_EXP_SECONDS && `access tokens do not expire after ${SHARD_JWT_EXP_SECONDS}s`,
  ].filter(Boolean);
  if (authProblems.length) return { status: "blocked", shard, step: "auth_config", reason: authProblems.join("; ") };
  await mark("auth_config");

  if (!done(shard, "signing_key")) {
    if (!deps.signer) return { status: "blocked", shard, step: "signing_key", reason: "signer Worker secrets are not wired" };
    const keys = await deps.mgmt.listSigningKeys(ref);
    const ours = keys.filter((k) => isZaviSigningKid(shard.id, k.kid));
    if (!ours.some((k) => k.status === "in_use")) {
      const kid = nextSigningKid(shard.id, keys.map((k) => k.kid));
      if (!kid) {
        return { status: "blocked", shard, step: "signing_key", reason: `all ${SIGNING_KID_SLOTS} Zavi signing key ids are already on the project (revoked ones included); delete revoked Zavi keys in the Supabase dashboard (Auth > Signing keys), or raise SIGNING_KID_SLOTS` };
      }
      let jwk: Record<string, unknown> | null = (deps.generateJwk ?? es256Jwk)(kid);
      await deps.signer.put(ref, jwk);
      const imported = await deps.mgmt.importSigningKey(ref, { private_jwk: jwk, status: "standby" });
      jwk = null;
      for (const stale of ours.filter((k) => k.status === "standby" && k.id !== imported.id)) {
        await deps.mgmt.setSigningKeyStatus(ref, stale.id, "revoked");
      }
      await deps.mgmt.setSigningKeyStatus(ref, imported.id, "in_use");
      const after = await deps.mgmt.listSigningKeys(ref);
      if (!after.some((k) => k.id === imported.id && k.status === "in_use")) {
        return { status: "blocked", shard, step: "signing_key", reason: "imported key is not current" };
      }
    }
    await mark("signing_key");
  }

  const apikey = await deps.mgmt.publishableKey(ref);
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(apikey)) {
    return { status: "blocked", shard, step: "gateway_kv", reason: "the project has no publishable key" };
  }
  const shardRecord = JSON.stringify({ apikey });
  if ((await deps.kv.get(shardKvKey(ref))) !== shardRecord) {
    await deps.kv.put(shardKvKey(ref), shardRecord);
    if ((await deps.kv.get(shardKvKey(ref))) !== shardRecord) {
      return { status: "blocked", shard, step: "gateway_kv", reason: "shard KV record did not read back" };
    }
  }
  await mark("gateway_kv");

  await mark(PROVISION_DONE);
  if (!kernel && shard.purpose === "validation") {
    if (shard.state === "provisioning") shard = await deps.registry.validationReady(shard.id);
    return { status: "ready", shard };
  }
  if (opts.open === false || shard.state !== "provisioning") return { status: shard.state === "open" ? "open" : "ready", shard };
  shard = await deps.registry.update(shard.id, { state: "open" });
  return { status: "open", shard };
}
