
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import { SiteCredentialsMissing } from "@/services/sites/contract";
import type { KvStore } from "./gateway-kv";

export interface ShardKeyStore {
  put(project_ref: string, privateJwk: Record<string, unknown>): Promise<void>;
  remove?(project_ref: string): Promise<void>;
}

export const shardKeySecretName = (project_ref: string) => `SHARD_KEY_${project_ref.toUpperCase().replace(/-/g, "_")}`;
export const sealedShardKeyKey = (project_ref: string) => `shardkey:${project_ref}`;
const REF_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

type CfFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number }>;

export function workerSecretKeyStore(deps: { env?: Record<string, string | undefined>; fetchFn?: CfFetch } = {}): ShardKeyStore {
  const env = deps.env ?? process.env;
  const fetchFn: CfFetch = deps.fetchFn ?? ((url, init) => fetch(url, init) as unknown as ReturnType<CfFetch>);
  return {
    async put(ref, jwk) {
      if (!REF_RE.test(ref)) throw new Error("invalid shard ref");
      const account = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
      const script = (env.SITE_SIGNER_WORKER_NAME ?? "").trim();
      const token = (env.CLOUDFLARE_SIGNER_API_TOKEN ?? "").trim();
      const missing = [!account && "CLOUDFLARE_ACCOUNT_ID", !script && "SITE_SIGNER_WORKER_NAME", !token && "CLOUDFLARE_SIGNER_API_TOKEN"].filter(Boolean) as string[];
      if (missing.length) throw new SiteCredentialsMissing(missing);
      const res = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${encodeURIComponent(script)}/secrets`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: shardKeySecretName(ref), text: JSON.stringify(jwk), type: "secret_text" }),
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`signer secret put failed (${res.status})`);
    },
    async remove(ref) {
      if (!REF_RE.test(ref)) throw new Error("invalid shard ref");
      const account = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
      const script = (env.SITE_SIGNER_WORKER_NAME ?? "").trim();
      const token = (env.CLOUDFLARE_SIGNER_API_TOKEN ?? "").trim();
      const missing = [!account && "CLOUDFLARE_ACCOUNT_ID", !script && "SITE_SIGNER_WORKER_NAME", !token && "CLOUDFLARE_SIGNER_API_TOKEN"].filter(Boolean) as string[];
      if (missing.length) throw new SiteCredentialsMissing(missing);
      const res = await fetchFn(
        `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${encodeURIComponent(script)}/secrets/${encodeURIComponent(shardKeySecretName(ref))}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.status !== 404 && (res.status < 200 || res.status >= 300)) throw new Error(`signer secret delete failed (${res.status})`);
    },
  };
}

const b64u = (b: Buffer) => b.toString("base64url");
const info = (kekKid: string, ref: string) => Buffer.from(`zavi-shard-key-v1|${kekKid}|${ref}`);

export type SealedShardKey = {
  v: 1;
  alg: "ECDH-ES+HKDF-SHA256+A256GCM";
  kek_kid: string;
  epk: { kty: "EC"; crv: "P-256"; x: string; y: string };
  iv: string;
  ct: string;
};

export function sealShardKey(kekPublicJwk: Record<string, unknown>, ref: string, privateJwk: Record<string, unknown>): SealedShardKey {
  if (!REF_RE.test(ref)) throw new Error("invalid shard ref");
  const kekKid = String(kekPublicJwk.kid ?? "");
  if (!kekKid || kekPublicJwk.d !== undefined) throw new Error("KEK must be a PUBLIC jwk with a kid");
  const kek: KeyObject = createPublicKey({ key: { kty: "EC", crv: "P-256", x: kekPublicJwk.x, y: kekPublicJwk.y } as never, format: "jwk" });
  const eph = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: kek });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), info(kekKid, ref), 32));
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(sealedShardKeyKey(ref)));
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(privateJwk))), c.final(), c.getAuthTag()]);
  const epk = eph.publicKey.export({ format: "jwk" }) as { x: string; y: string };
  return { v: 1, alg: "ECDH-ES+HKDF-SHA256+A256GCM", kek_kid: kekKid, epk: { kty: "EC", crv: "P-256", x: epk.x, y: epk.y }, iv: b64u(iv), ct: b64u(ct) };
}

export function openSealedShardKey(kekPrivateJwk: Record<string, unknown>, ref: string, sealed: SealedShardKey): Record<string, unknown> {
  const kek = createPrivateKey({ key: kekPrivateJwk as never, format: "jwk" });
  const epk = createPublicKey({ key: sealed.epk as never, format: "jwk" });
  const shared = diffieHellman({ privateKey: kek, publicKey: epk });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), info(sealed.kek_kid, ref), 32));
  const raw = Buffer.from(sealed.ct, "base64url");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64url"));
  d.setAAD(Buffer.from(sealedShardKeyKey(ref)));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString("utf8"));
}

export function sealedKvKeyStore(deps: { kv: KvStore; kekPublicJwk: () => Record<string, unknown> }): ShardKeyStore {
  return {
    async put(ref, jwk) {
      const sealed = sealShardKey(deps.kekPublicJwk(), ref, jwk);
      await deps.kv.put(sealedShardKeyKey(ref), JSON.stringify(sealed));
      const back = await deps.kv.get(sealedShardKeyKey(ref));
      if (!back || (JSON.parse(back) as SealedShardKey).ct !== sealed.ct) throw new Error("sealed shard key did not read back");
    },
    async remove(ref) {
      if (!REF_RE.test(ref)) throw new Error("invalid shard ref");
      if (!deps.kv.delete) throw new Error("kv store cannot delete");
      await deps.kv.delete(sealedShardKeyKey(ref));
      if (await deps.kv.get(sealedShardKeyKey(ref))) throw new Error("sealed shard key is still present");
    },
  };
}
