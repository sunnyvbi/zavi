import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 10 * 1024 * 1024;

export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === "::" || l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
}

export async function safeFetchImage(url: string): Promise<{ bytes: Buffer; mime: string } | null> {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:") return null;
  try {
    const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some((x) => isPrivateAddress(x.address))) return null;
    const r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (r.status !== 200) return null;
    const mime = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!mime.startsWith("image/")) return null;
    if (!r.body) return null;
    if (Number(r.headers.get("content-length") ?? 0) > MAX_BYTES) {
      await r.body.cancel().catch(() => {});
      return null;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks);
    return bytes.byteLength > 0 ? { bytes, mime } : null;
  } catch {
    return null;
  }
}
