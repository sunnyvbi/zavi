
import { promises as dns } from "node:dns";
import net from "node:net";

export class SsrfBlockedError extends Error {
  readonly code: "ssrf_blocked" | "ssrf_scheme" | "ssrf_dns_failed" | "ssrf_parse" =
    "ssrf_blocked";
  constructor(message: string, code?: SsrfBlockedError["code"]) {
    super(message);
    if (code) this.code = code;
    this.name = "SsrfBlockedError";
  }
}

const IPV4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return -1;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isIpv4Blocked(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  if (ipInt < 0) return true;
  for (const [base, bits] of IPV4_BLOCKED) {
    const baseInt = ipv4ToInt(base);
    if (baseInt < 0) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((ipInt & mask) === (baseInt & mask)) return true;
  }
  return false;
}

export function ipv6Hextets(ip: string): number[] | null {
  let v = ip.toLowerCase().replace(/%.*$/, "");
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    if (n < 0) return null;
    v = v.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = v.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const parts = [...head, ...Array(fill).fill("0"), ...tail];
  if (parts.length !== 8 || parts.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  return parts.map((h) => parseInt(h, 16));
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

function isIpv6Blocked(ip: string): boolean {
  const h = ipv6Hextets(ip);
  if (!h) return true;
  const zeros = (n: number) => h.slice(0, n).every((x) => x === 0);
  if (zeros(8) || (zeros(7) && h[7] === 1)) return true;
  if (zeros(5) && h[5] === 0xffff) return isIpv4Blocked(v4Of(h[6], h[7]));
  if (zeros(6)) return true;
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return isIpv4Blocked(v4Of(h[6], h[7]));
  if (h[0] === 0x2002) return isIpv4Blocked(v4Of(h[1], h[2]));
  if ((h[0] & 0xfe00) === 0xfc00) return true;
  if ((h[0] & 0xffc0) === 0xfe80) return true;
  if ((h[0] & 0xffc0) === 0xfec0) return true;
  if ((h[0] & 0xff00) === 0xff00) return true;
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true;
  if (h[0] === 0x0100 && h.slice(1, 4).every((x) => x === 0)) return true;
  return false;
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isIpv4Blocked(ip);
  if (net.isIPv6(ip)) return isIpv6Blocked(ip);
  return true;
}

export async function assertSafeUrl(urlStr: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new SsrfBlockedError(`URL parse failed`, "ssrf_parse");
  }
  if (url.protocol !== "https:") {
    throw new SsrfBlockedError(`Scheme rejected: ${url.protocol}`, "ssrf_scheme");
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      throw new SsrfBlockedError(`Literal IP ${host} is in a blocked range`);
    }
    return url;
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (e) {
    throw new SsrfBlockedError(`DNS lookup failed for ${host}`, "ssrf_dns_failed");
  }
  if (addrs.length === 0) {
    throw new SsrfBlockedError(`DNS returned no addresses for ${host}`, "ssrf_dns_failed");
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new SsrfBlockedError(`${host} resolves to blocked IP ${a.address}`);
    }
  }
  return url;
}
