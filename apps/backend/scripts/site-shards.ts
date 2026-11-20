
import { cloudflareKv } from "@/services/site-shards/gateway-kv";
import { runShardMetricsSweep } from "@/services/site-shards/metrics";
import { loadShardMigrations } from "@/services/site-shards/migrations";
import { PROVISION_STEPS, SHARD_AUTH_RATE_LIMITS, SHARD_JWT_EXP_SECONDS, isZaviSigningKid } from "@/services/site-shards/provision";
import { PROVISION_ENV, runProvisionShard } from "@/services/site-shards/provision-run";
import { shardEnv, shardRegistry } from "@/services/site-shards/registry";
import { rolloutShardSchema } from "@/services/site-shards/rollout";
import { createShardMgmt, platformRefs } from "@/services/site-shards/shard-mgmt";
import { shardKvKey, shardName, type ShardEnv } from "@/services/site-shards/contract";
import { signerConfigured } from "@/services/site-shards/readiness";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const env = arg("env") as ShardEnv | undefined;
  if (env !== "dev" && env !== "prod") throw new Error("--env dev|prod is required");
  if (env !== shardEnv()) {
    throw new Error(`--env ${env} does not match this backend's shard env (${shardEnv()}, from SUPABASE_URL / SITE_SHARD_ENV): refusing`);
  }
  const registry = shardRegistry();

  if (cmd === "preflight" || (cmd === "provision" && flag("dry-run"))) {
    process.exitCode = await preflight(env, Number(arg("n") ?? "1"));
    return;
  }
  if (cmd === "verify") {
    process.exitCode = await verify(env, Number(arg("n")));
    return;
  }

  if (cmd === "list") {
    for (const s of await registry.list(env)) {
      console.log(`${s.name} ${s.state} ref=${s.project_ref ?? "-"} schema=${s.schema_version ?? "-"} step=${s.provision_step ?? "-"} sites=${s.site_count}/${s.max_sites}`);
    }
    return;
  }
  if (cmd === "metrics") {
    console.log(JSON.stringify(await runShardMetricsSweep()));
    return;
  }
  if (cmd === "rollout") {
    const dryRun = flag("dry-run");
    if (!dryRun && !flag("i-mean-it")) throw new Error("a real rollout needs --i-mean-it (try --dry-run first)");
    const mgmt = createShardMgmt();
    const soak = Number(arg("canary-soak-seconds") ?? "60");
    if (!Number.isInteger(soak) || soak < 0 || soak > 3600) throw new Error("--canary-soak-seconds must be 0..3600");
    const { productionAlert } = await import("@/services/site-shards/autoprovision");
    const report = await rolloutShardSchema(
      { registry, sql: mgmt, files: loadShardMigrations(), canarySoakMs: soak * 1000, alert: productionAlert, log: console.warn },
      { env, dryRun },
    );
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (cmd === "provision") {
    if (!flag("i-mean-it")) throw new Error("provision creates a paid project: pass --i-mean-it");
    const n = Number(arg("n"));
    if (!Number.isInteger(n) || n < 1) throw new Error("--n <shard number> is required");
    const result = await runProvisionShard({ env, n, region: arg("region") ?? "us-west-1", canary: flag("canary"), open: !flag("no-open") });
    console.log(JSON.stringify({ status: result.status, shard: result.shard.name, ...("step" in result ? { step: result.step, reason: result.reason } : {}) }));
    if (result.status === "blocked") process.exitCode = 1;
    return;
  }
  throw new Error("usage: site-shards preflight|provision|verify|rollout|metrics|list --env dev|prod");
}

const present = (k: string) => !!(process.env[k] ?? "").trim();
const https = (k: string) => /^https:\/\//.test((process.env[k] ?? "").trim());

function check(ok: boolean, label: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  return ok;
}

async function preflight(env: ShardEnv, n: number): Promise<number> {
  if (!Number.isInteger(n) || n < 1) throw new Error("--n <shard number> is required");
  const name = shardName(env, n);
  let ok = true;
  console.log(`preflight: shard ${name} (env ${env}); nothing is written`);
  for (const k of PROVISION_ENV) ok = check(present(k), `env ${k} is set`) && ok;
  ok = check(https("SITE_AUTH_HOOK_BASE_URL"), "SITE_AUTH_HOOK_BASE_URL is https") && ok;
  ok = check(https("SITE_AUTH_BROKER_CALLBACK_URL"), "SITE_AUTH_BROKER_CALLBACK_URL is https") && ok;
  ok = check(signerConfigured(), `signer key store: ${present("SITE_SIGNER_KEK_PUBLIC_JWK") ? "sealed KV (public KEK)" : "Worker secrets"}`) && ok;
  const files = loadShardMigrations();
  for (const f of files) console.log(`      sql ${f.version} sha256=${f.sha256}`);
  ok = check(files.some((f) => f.version.startsWith("0010")) && files.some((f) => f.version.startsWith("1003")), `${files.length} shard SQL files (0001-0010 + auth 1001+)`) && ok;
  const own = platformRefs();
  ok = check(own.size >= 2, `Zavi platform refs guarded (${own.size})`) && ok;
  try {
    const mgmt = createShardMgmt();
    const found = await mgmt.listProjectsByName(name);
    ok = check(found.length <= 1, `projects named ${name} in the sites org: ${found.length} (provision ${found.length ? "reuses it" : "CREATES one: paid"})`) && ok;
  } catch (e) {
    ok = check(false, `sites org readable with SUPABASE_MGMT_TOKEN: ${String((e as Error)?.message ?? e).slice(0, 160)}`) && ok;
  }
  const rows = await shardRegistry().list(env);
  const row = rows.find((r) => r.name === name);
  console.log(`      registry (${env}): ${rows.length} shard(s); ${name}: ${row ? `${row.state} step=${row.provision_step ?? "-"}` : "absent (provision registers it)"}`);
  console.log(`      provision steps: ${PROVISION_STEPS.join(" -> ")}`);
  console.log(ok ? "READY: run provision with --i-mean-it" : "NOT READY: fix the FAIL lines first");
  return ok ? 0 : 1;
}

async function verify(env: ShardEnv, n: number): Promise<number> {
  if (!Number.isInteger(n) || n < 1) throw new Error("--n <shard number> is required");
  const name = shardName(env, n);
  const row = (await shardRegistry().list(env)).find((r) => r.name === name);
  if (!row?.project_ref) {
    console.log(`FAIL  ${name} is not in the ${env} registry with a project`);
    return 1;
  }
  const ref = row.project_ref;
  const mgmt = createShardMgmt();
  let ok = true;
  ok = check(row.state === "open" || row.state === "full", `registry: state ${row.state}, step ${row.provision_step ?? "-"}`) && ok;
  ok = check(row.provision_step === "done", "registry: provision_step = done") && ok;
  const files = loadShardMigrations();
  const ledger = (await mgmt.query(ref, "select version, checksum from zsite.migrations order by version")) as Array<{ version: string; checksum: string | null }>;
  for (const f of files) {
    const l = ledger.find((x) => x.version === f.version);
    ok = check(!!l && l.checksum === f.sha256, `ledger ${f.version} applied with matching sha256`) && ok;
  }
  ok = check((await mgmt.getExposedSchemas(ref)).replace(/\s/g, "") === "api", "Data API exposed schemas = api only") && ok;
  const gql = (await mgmt.query(ref, "select count(*)::int as n from pg_extension where extname = 'pg_graphql'")) as Array<{ n: number }>;
  ok = check(Number(gql[0]?.n) === 0, "GraphQL off (pg_graphql not installed)") && ok;
  const auth = await mgmt.getAuthConfig(ref);
  const cb = (process.env.SITE_AUTH_BROKER_CALLBACK_URL ?? "").trim();
  ok = check(Number(auth.jwt_exp) === SHARD_JWT_EXP_SECONDS, `JWT expiry = ${SHARD_JWT_EXP_SECONDS}s`) && ok;
  ok = check(auth.external_email_enabled === true, "email auth on") && ok;
  ok = check(auth.hook_custom_access_token_enabled === true && auth.hook_custom_access_token_uri === "pg-functions://postgres/zsite_auth/custom_access_token_hook", "custom access token hook = zsite_auth.custom_access_token_hook") && ok;
  ok = check(auth.hook_send_email_enabled === true && String(auth.hook_send_email_uri ?? "").endsWith(`/api/public/site-auth/hooks/send-email/${ref}`), "Send Email Hook -> Zavi API") && ok;
  ok = check(!!cb && auth.site_url === new URL(cb).toString() && auth.uri_allow_list === new URL(cb).toString(), "site_url + redirect allowlist = the ONE broker callback") && ok;
  for (const [k, v] of Object.entries(SHARD_AUTH_RATE_LIMITS)) ok = check(Number(auth[k]) === v, `GoTrue ${k} = ${v}`) && ok;
  const keys = await mgmt.listSigningKeys(ref);
  const ours = keys.filter((k) => isZaviSigningKid(row.id, k.kid));
  ok = check(ours.filter((k) => k.status === "in_use").length === 1 && ours.every((k) => k.algorithm.toUpperCase() === "ES256"), `signing key: one Zavi ES256 key in use (${ours.length} Zavi keys total)`) && ok;
  const kvRec = await cloudflareKv().get(shardKvKey(ref));
  let apikeyOk = false;
  try {
    apikeyOk = /^sb_publishable_/.test(String((JSON.parse(kvRec ?? "null") as { apikey?: unknown } | null)?.apikey ?? ""));
  } catch {
    apikeyOk = false;
  }
  ok = check(apikeyOk, `KV ${shardKvKey(ref)} holds a publishable key (value not printed)`) && ok;
  const facade = (await mgmt.query(ref, "select count(*)::int as n from pg_roles where rolname in ('zsite_facade','zsite_kernel','zsite_broker')")) as Array<{ n: number }>;
  ok = check(Number(facade[0]?.n) === 3, "roles zsite_facade, zsite_kernel, zsite_broker exist") && ok;
  console.log(ok ? `VERIFIED: ${name} (${ref})` : `NOT VERIFIED: ${name}`);
  return ok ? 0 : 1;
}

main().catch((e: unknown) => {
  console.error(String((e as Error)?.message ?? e));
  process.exit(1);
});
