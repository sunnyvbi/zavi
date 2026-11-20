
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

export const PINNED_FETCH_MAX_BYTES = 15 * 1024 * 1024;

const NOT_PUBLIC_V4 = new BlockList();
const NOT_PUBLIC_V6 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NOT_PUBLIC_V4.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["::ffff:0:0:0", 96], ["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) NOT_PUBLIC_V6.addSubnet(net, bits, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return family === 4 ? !NOT_PUBLIC_V4.check(address, "ipv4") : !NOT_PUBLIC_V6.check(address, "ipv6");
}
const TIMEOUT_MS = 20_000;

export type PinnedFetchDeps = {
  resolve: (host: string) => Promise<Array<{ address: string; family: number }>>;
  get: (url: URL, address: string, family: number) => Promise<{ status: number; type: string; bytes: Uint8Array | null }>;
};

export function pinnedLookup(address: string, family: number): LookupFunction {
  return ((_host: string, opts: { all?: boolean } | undefined, cb: (...args: unknown[]) => void) => {
    if (opts && opts.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  }) as unknown as LookupFunction;
}

function realGet(url: URL, address: string, family: number, maxBytes: number): Promise<{ status: number; type: string; bytes: Uint8Array | null }> {
  return new Promise((resolve) => {
    const req = request(
      url,
      {
        method: "GET",
        timeout: TIMEOUT_MS,
        headers: { accept: "image/*" },
        lookup: pinnedLookup(address, family),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const type = String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        if (status !== 200 || !type.startsWith("image/")) {
          res.resume();
          resolve({ status, type, bytes: null });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            resolve({ status, type, bytes: null });
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, type, bytes: new Uint8Array(Buffer.concat(chunks)) }));
        res.on("error", () => resolve({ status, type, bytes: null }));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ status: 0, type: "", bytes: null }));
    req.end();
  });
}

export const realPinnedFetchDeps: PinnedFetchDeps = {
  resolve: async (host) => (isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true })),
  get: (url, address, family) => realGet(url, address, family, PINNED_FETCH_MAX_BYTES),
};

export async function fetchPublicImage(raw: string, deps: PinnedFetchDeps = realPinnedFetchDeps): Promise<Uint8Array | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await deps.resolve(host);
  } catch {
    return null;
  }
  if (addrs.length === 0 || addrs.some((a) => !isPublicAddress(a.address))) return null;
  const pick = addrs[0]!;
  const r = await deps.get(url, pick.address, pick.family).catch(() => null);
  if (!r?.bytes || r.bytes.byteLength === 0 || r.bytes.byteLength > PINNED_FETCH_MAX_BYTES) return null;
  return r.bytes;
}
