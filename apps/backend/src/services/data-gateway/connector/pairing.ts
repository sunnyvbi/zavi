import { asTenantId, preTenantRpc, tenantRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { alert } from "@/services/logging/alert";
import { dockerCommand, generateConnectorToken, generatePairCode, normalizePairCode, sha256Hex } from "./token";
import { publishRevoke } from "./wakeup";
import { GLOBAL_ALERT_PER_HOUR, refundPairAttempt, reservePairAttempt, type RateLimitDeps } from "./rate-limit";

type RpcFn = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string | null; message?: string } | null }>;

export type PairCode = { code: string; pairing_id: string; issued_at: string; expires_at: string; expires_in_seconds: number; command: string };

export async function createPairCode(userRpc: RpcFn, tenant_id: string): Promise<PairCode> {
  const code = generatePairCode();
  const { data, error } = await userRpc("create_db_connector_pair_code", { p_tenant_id: tenant_id, p_code_hash: sha256Hex(code) });
  if (error) throw Object.assign(new Error("create_db_connector_pair_code failed"), { code: error.code ?? null });
  const row = Array.isArray(data) ? (data[0] as { code_id?: string; issued_at?: string; expires_at?: string } | undefined) : undefined;
  if (!row?.code_id || !row.issued_at || !row.expires_at) throw Object.assign(new Error("create_db_connector_pair_code returned no row"), { code: null });
  const expires_in_seconds = Math.max(0, Math.round((Date.parse(row.expires_at) - Date.parse(row.issued_at)) / 1000));
  return { code, pairing_id: row.code_id, issued_at: row.issued_at, expires_at: row.expires_at, expires_in_seconds, command: dockerCommand(code) };
}

export type RedeemInput = { code: unknown; machine: string; version: string; ip: string | null | undefined };
export type RedeemResult =
  | { ok: true; token: string; tenant_id: string; connector_id: string }
  | { ok: false; status: 401 | 429 | 503; reason: "invalid_code" | "rate_limited" | "unavailable" };

export type PairingDeps = {
  preTenantRpc: typeof preTenantRpc;
  tenantRpc: typeof tenantRpc;
  limits?: RateLimitDeps;
  log: typeof logEvent;
  alert: typeof alert;
  newToken: () => string;
  revoke: (tenant_id: string) => Promise<void>;
};
const DEFAULT: PairingDeps = {
  preTenantRpc: (...a) => preTenantRpc(...a),
  tenantRpc: (...a) => tenantRpc(...a),
  log: (i) => logEvent(i),
  alert: (i) => alert(i),
  newToken: () => generateConnectorToken(),
  revoke: (t) => publishRevoke(t),
};

async function failed(d: PairingDeps, stage: string, tenant_id: string | null = null): Promise<void> {
  await d.log({ level: "warn", source: "db-connector.pair", code: "pair_failed", tenant_id, meta: { stage } });
}

export async function redeemPairCode(input: RedeemInput, deps: Partial<PairingDeps> = {}): Promise<RedeemResult> {
  const d: PairingDeps = { ...DEFAULT, ...deps };
  const code = normalizePairCode(input.code);
  if (!code) {
    await failed(d, "malformed");
    return { ok: false, status: 401, reason: "invalid_code" };
  }

  const reserved = await reservePairAttempt(input.ip, d.limits);
  if (reserved.kind === "unavailable") {
    await d.log({ level: "error", source: "db-connector.pair", code: "pair_limiter_unavailable", meta: { stage: "reserve" } });
  }
  if (reserved.kind === "limited") {
    await d.log({ level: "warn", source: "db-connector.pair", code: "pair_rate_limited", meta: { stage: "ip" } });
    return { ok: false, status: 429, reason: "rate_limited" };
  }

  const codeHash = sha256Hex(code);
  const { data: resolved, error: resolveErr } = await d.preTenantRpc("db_connector_resolve_pair_code", { p_code_hash: codeHash });
  if (resolveErr) {
    await d.log({ level: "error", source: "db-connector.pair", code: "pair_resolve_failed", meta: { stage: "resolve" } });
    return { ok: false, status: 503, reason: "unavailable" };
  }
  const row = Array.isArray(resolved) ? (resolved[0] as { tenant_id?: string; code_id?: string } | undefined) : undefined;
  if (!row?.tenant_id || !row.code_id) {
    await failed(d, "unknown_or_expired");
    if (reserved.kind === "ok") await maybeAlertGlobal(d, reserved.global_attempts);
    return { ok: false, status: 401, reason: "invalid_code" };
  }

  const token = d.newToken();
  const tid = asTenantId(row.tenant_id);
  const { data: connectorId, error: redeemErr } = await d.tenantRpc(tid, "redeem_db_connector_pair_code", {
    p_code_id: row.code_id,
    p_code_hash: codeHash,
    p_token_hash: sha256Hex(token),
    p_machine: input.machine,
    p_version: input.version,
  });
  if (redeemErr) {
    await d.log({ level: "error", source: "db-connector.pair", code: "pair_redeem_failed", tenant_id: row.tenant_id, meta: { stage: "redeem" } });
    return { ok: false, status: 503, reason: "unavailable" };
  }
  if (typeof connectorId !== "string" || !connectorId) {
    await failed(d, "raced", row.tenant_id);
    return { ok: false, status: 401, reason: "invalid_code" };
  }
  await refundPairAttempt(input.ip, d.limits);
  await d.revoke(row.tenant_id).catch(() => undefined);
  await d.log({ level: "info", source: "db-connector.pair", code: "pair_succeeded", tenant_id: row.tenant_id, meta: { stage: "redeemed" } });
  return { ok: true, token, tenant_id: row.tenant_id, connector_id: connectorId };
}

async function maybeAlertGlobal(d: PairingDeps, globalAttempts: number): Promise<void> {
  if (globalAttempts < GLOBAL_ALERT_PER_HOUR) return;
  await d.alert({
    source: "db-connector.pair",
    code: "pair_global_failure_rate",
    msg: `Zavi Connector pairing saw ${globalAttempts} failed attempts in the last hour (alert at ${GLOBAL_ALERT_PER_HOUR}). Pairing is not blocked; check for abuse.`,
  });
}
