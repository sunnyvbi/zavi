import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { dbConnectorPlatformRpc } from "@/services/tenant-client";

export const PER_IP_PER_HOUR = 10;
export const PER_SUBNET_PER_HOUR = 30;
export const GLOBAL_ALERT_PER_HOUR = 200;

export const PEPPER_LABEL = "zavi:db-connector:ip-pepper:v1";

export function ipPepper(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!root || root.length < 16) return null;
  return createHmac("sha256", root).update(PEPPER_LABEL).digest("hex");
}

export function subnetOf(ip: string | null | undefined): string {
  if (!ip) return "unknown";
  let a = ip.trim().replace(/%.*$/, "");
  if (/^::ffff:/i.test(a) && isIP(a.slice(7)) === 4) a = a.slice(7);
  if (isIP(a) === 4) return `${a.split(".").slice(0, 3).join(".")}.0/24`;
  if (isIP(a) === 6) {
    const [head, tail] = a.toLowerCase().split("::");
    const h = head ? head.split(":") : [];
    const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
    const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
    return `${groups.slice(0, 4).map((g) => String(parseInt(g || "0", 16).toString(16))).join(":")}::/64`;
  }
  return "unknown";
}

export function netScope(ip: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const pepper = ipPepper(env);
  if (!pepper) return null;
  return "net:" + createHmac("sha256", pepper).update(subnetOf(ip)).digest("hex");
}

export function ipScope(ip: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const pepper = ipPepper(env);
  if (!pepper) return null;
  return "ip:" + createHmac("sha256", pepper).update(ip || "unknown").digest("hex");
}

export type ReserveOutcome = { kind: "ok"; global_attempts: number } | { kind: "limited" } | { kind: "unavailable" };

export type RateLimitDeps = { rpc: typeof dbConnectorPlatformRpc; env?: NodeJS.ProcessEnv };
const DEFAULT: RateLimitDeps = { rpc: (...a) => dbConnectorPlatformRpc(...a) };

export async function reservePairAttempt(ip: string | null | undefined, deps: RateLimitDeps = DEFAULT): Promise<ReserveOutcome> {
  const scope = ipScope(ip, deps.env);
  const net = netScope(ip, deps.env);
  if (!scope || !net) return { kind: "unavailable" };
  try {
    const { data, error } = await deps.rpc("db_connector_pair_reserve", { p_ip_scope: scope, p_net_scope: net });
    const row = Array.isArray(data) ? (data[0] as { allowed?: boolean; global_attempts?: number } | undefined) : undefined;
    if (error || !row || typeof row.allowed !== "boolean") return { kind: "unavailable" };
    return row.allowed ? { kind: "ok", global_attempts: Number(row.global_attempts ?? 0) } : { kind: "limited" };
  } catch {
    return { kind: "unavailable" };
  }
}

export async function refundPairAttempt(ip: string | null | undefined, deps: RateLimitDeps = DEFAULT): Promise<void> {
  const scope = ipScope(ip, deps.env);
  const net = netScope(ip, deps.env);
  if (!scope || !net) return;
  try {
    await deps.rpc("db_connector_pair_refund", { p_ip_scope: scope, p_net_scope: net });
  } catch {
  }
}
