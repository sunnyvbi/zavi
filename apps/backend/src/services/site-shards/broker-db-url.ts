
import type { ShardRow } from "./contract";
import type { ShardSecretStore } from "./registry";

export const BROKER_ROLE = "zsite_broker";
export const SHARD_POOLER_PORT = 6543;
export const BROKER_STATEMENT_TIMEOUT = "10s";
export const BROKER_ROLE_TIMEOUT_SQL = `alter role ${BROKER_ROLE} set statement_timeout = '${BROKER_STATEMENT_TIMEOUT}'`;

const POOLER_HOST_RE = /^[a-z0-9-]+\.pooler\.supabase\.com$/;
const DIRECT_HOST_RE = /^db\.[a-z0-9]+\.supabase\.co$/;
const REF_RE = /^[a-z0-9]{8,40}$/;

export function assertPoolerHost(host: unknown): string {
  const h = typeof host === "string" ? host.trim().toLowerCase() : "";
  if (!POOLER_HOST_RE.test(h)) throw new Error("the project's pooler host is not a *.pooler.supabase.com host");
  return h;
}

export function brokerDbUrl(ref: string, password: string, poolerHost: string): string {
  if (!REF_RE.test(ref)) throw new Error("invalid project ref");
  if (!password) throw new Error("broker password is empty");
  const host = assertPoolerHost(poolerHost);
  return `postgresql://${BROKER_ROLE}.${ref}:${encodeURIComponent(password)}@${host}:${SHARD_POOLER_PORT}/postgres?sslmode=require`;
}

function parseUrl(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === "postgresql:" || u.protocol === "postgres:" ? u : null;
  } catch {
    return null;
  }
}

export function isDirectShardDbUrl(url: string | null | undefined): boolean {
  const u = url ? parseUrl(url) : null;
  return !!u && DIRECT_HOST_RE.test(u.hostname.toLowerCase());
}

export function isPooledBrokerDbUrl(url: string | null | undefined, ref: string): boolean {
  const u = url ? parseUrl(url) : null;
  if (!u) return false;
  if (!POOLER_HOST_RE.test(u.hostname.toLowerCase())) return false;
  if (u.port !== String(SHARD_POOLER_PORT)) return false;
  if (decodeURIComponent(u.username) !== `${BROKER_ROLE}.${ref}`) return false;
  const keys = [...u.searchParams.keys()];
  return keys.length === 1 && keys[0] === "sslmode" && u.searchParams.get("sslmode") === "require";
}

export function pooledFromStored(stored: string, ref: string, poolerHost: string): string {
  const u = parseUrl(stored);
  if (!u) throw new Error("stored broker URL is not a postgres URL");
  const user = decodeURIComponent(u.username);
  const host = u.hostname.toLowerCase();
  const sameProject =
    (user === BROKER_ROLE && host === `db.${ref}.supabase.co`) ||
    (user === `${BROKER_ROLE}.${ref}` && POOLER_HOST_RE.test(host));
  if (!sameProject) throw new Error("stored broker URL is not this project's zsite_broker login");
  return brokerDbUrl(ref, decodeURIComponent(u.password), poolerHost);
}

export type BrokerUrlRepairDeps = {
  secrets: ShardSecretStore;
  mgmt: { poolerHost(ref: string): Promise<string>; query(ref: string, sql: string): Promise<unknown[]> };
  log?: (line: string) => void;
};

export type BrokerUrlRepairOutcome = "repaired" | "ok" | "missing" | "skipped";

export async function repairShardBrokerDbUrl(
  deps: BrokerUrlRepairDeps,
  shard: Pick<ShardRow, "id" | "name" | "project_ref" | "state">,
  opts: { ensureRoleTimeout?: boolean } = {},
): Promise<BrokerUrlRepairOutcome> {
  const ref = shard.project_ref;
  if (!ref || shard.state === "retired") return "skipped";
  const stored = await deps.secrets.getSecret(shard.id, "broker_db_url");
  if (!stored) return "missing";
  if (isPooledBrokerDbUrl(stored, ref)) {
    if (opts.ensureRoleTimeout) await deps.mgmt.query(ref, BROKER_ROLE_TIMEOUT_SQL);
    return "ok";
  }
  const next = pooledFromStored(stored, ref, await deps.mgmt.poolerHost(ref));
  await deps.mgmt.query(ref, BROKER_ROLE_TIMEOUT_SQL);
  await deps.secrets.setSecret(shard.id, "broker_db_url", next);
  deps.log?.(`[site-shards] broker_db_url ${shard.name}: rewritten to the pooler`);
  return "repaired";
}

export async function repairBrokerDbUrls(
  deps: BrokerUrlRepairDeps & { listShards(): Promise<Array<Pick<ShardRow, "id" | "name" | "project_ref" | "state">>> },
): Promise<{ repaired: number; ok: number; missing: number; failed: number; failed_names: string[] }> {
  const out = { repaired: 0, ok: 0, missing: 0, failed: 0, failed_names: [] as string[] };
  for (const s of await deps.listShards()) {
    if (s.state === "provisioning") continue;
    try {
      const r = await repairShardBrokerDbUrl(deps, s, { ensureRoleTimeout: true });
      if (r === "repaired") out.repaired++;
      else if (r === "ok") out.ok++;
      else if (r === "missing") out.missing++;
    } catch (e) {
      out.failed++;
      out.failed_names.push(s.name);
      deps.log?.(`[site-shards] broker_db_url repair ${s.name}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }
  return out;
}
