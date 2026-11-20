
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const GW = {
  ts: "x-zavi-gw-ts",
  requestId: "x-zavi-gw-request-id",
  site: "x-zavi-gw-site-id",
  host: "x-zavi-gw-host",
  shard: "x-zavi-gw-shard-id",
  ip: "x-zavi-gw-client-ip",
  sig: "x-zavi-gw-sig",
} as const;
export const GW_MAX_SKEW_S = 60;
export const GW_NONCE_TTL_S = 5 * 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IP_RE = /^[0-9a-f.:]{2,45}$/i;
const REQ_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const SHARD_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
const ACTION_RE = /^[a-z][a-z-]{0,31}$/;

export interface GatewayFields {
  ts: string;
  requestId: string;
  siteId: string;
  host: string;
  shardId: string;
  method: string;
  action: string;
  query: string;
  ip: string;
  body: Buffer;
}

export function canonicalGatewayString(f: GatewayFields): string {
  const bodyHash = createHash("sha256").update(f.body).digest("hex");
  return [
    "zavi-gw-v1", f.ts, f.requestId, f.siteId, f.host, f.shardId, f.method.toUpperCase(), f.action, f.query, f.ip, bodyHash,
  ].join("\n");
}

export function signGatewayRequest(secret: string, f: GatewayFields): string {
  return createHmac("sha256", secret).update(canonicalGatewayString(f)).digest("hex");
}

export type GatewayVerdict =
  | { ok: true; siteId: string; host: string; shardId: string; ip: string; requestId: string; ts: number }
  | { ok: false; reason: "missing" | "malformed" | "stale" | "bad_signature" };

export function verifyGatewayRequest(
  secret: string,
  f: Partial<Omit<GatewayFields, "body" | "method" | "action" | "query">> &
    Pick<GatewayFields, "body" | "method" | "action" | "query"> & { sig?: string },
  nowMs: number,
): GatewayVerdict {
  const { ts, requestId, siteId, host, shardId, ip, sig } = f;
  if (!ts || !requestId || !siteId || !host || !shardId || !ip || !sig) return { ok: false, reason: "missing" };
  if (!/^\d{9,11}$/.test(ts) || !/^[0-9a-f]{64}$/i.test(sig)) return { ok: false, reason: "malformed" };
  if (!UUID_RE.test(siteId) || !HOST_RE.test(host) || !IP_RE.test(ip) || !REQ_ID_RE.test(requestId)
      || !SHARD_RE.test(shardId) || !ACTION_RE.test(f.action)) {
    return { ok: false, reason: "malformed" };
  }
  if (Math.abs(nowMs / 1000 - Number(ts)) > GW_MAX_SKEW_S) return { ok: false, reason: "stale" };
  const want = Buffer.from(
    signGatewayRequest(secret, { ts, requestId, siteId, host, shardId, ip, method: f.method, action: f.action, query: f.query, body: f.body }),
    "hex",
  );
  const got = Buffer.from(sig.toLowerCase(), "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "bad_signature" };
  return { ok: true, siteId, host, shardId, ip, requestId, ts: Number(ts) };
}
