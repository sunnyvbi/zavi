
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SKEW_S = 60;
export const FD = { ts: "x-zavi-fd-ts", meta: "x-zavi-fd-meta", sig: "x-zavi-fd-sig", method: "x-zavi-fd-method" } as const;
export const FL = { ts: "x-zavi-fl-ts", sig: "x-zavi-fl-sig" } as const;

export interface ScheduleInvocationMeta {
  v: 1;
  site_id: string;
  host: string;
  kind: "schedule";
  name: string;
  request_id: string;
  user: null;
  scheduled_time: string;
  idempotency_key: string;
  attempt: number;
}

const sha256Hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmacHex = (secret: string, msg: string) => createHmac("sha256", secret).update(msg, "utf8").digest("hex");
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function signInvocation(secret: string, meta: ScheduleInvocationMeta, method: string, body: Buffer, nowMs: number): Record<string, string> {
  const ts = Math.floor(nowMs / 1000);
  const m = b64url(JSON.stringify(meta));
  const sig = hmacHex(secret, ["zavi-fd-v1", ts, m, method.toUpperCase(), sha256Hex(body)].join("\n"));
  return { [FD.ts]: String(ts), [FD.meta]: m, [FD.sig]: sig, [FD.method]: method.toUpperCase() };
}

export function verifyLogBatch(secret: string | undefined, header: (n: string) => string | undefined, body: Buffer, nowMs: number): boolean {
  if (!secret) return false;
  const tsRaw = header(FL.ts) ?? "";
  const sig = header(FL.sig) ?? "";
  if (!/^\d{1,12}$/.test(tsRaw) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const ts = Number(tsRaw);
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > SKEW_S) return false;
  const want = Buffer.from(hmacHex(secret, ["zavi-fl-v1", ts, sha256Hex(body)].join("\n")), "hex");
  const got = Buffer.from(sig, "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}
