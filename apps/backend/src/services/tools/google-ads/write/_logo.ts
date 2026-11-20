
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import net from "node:net";
import { isPrivateIp } from "@/services/onboarding/enrichment/url-guard";
import { tenantStorage, type TenantId } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";

export const AD_ASSETS_BUCKET = "ad-assets";
export const LOGO_MAX_BYTES = 5_120_000;
export const LOGO_MIN_SIDE = 128;
const FETCH_DEADLINE_MS = 15_000;

export type LogoMime = "image/png" | "image/jpeg";
export type LogoRef = {
  storage_path: string;
  sha256: string;
  mime: LogoMime;
  width: number;
  height: number;
};

export function sniffLogoMime(bytes: Buffer): LogoMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

export function imageDimensions(bytes: Buffer): { width: number; height: number } | null {
  const mime = sniffLogoMime(bytes);
  if (mime === "image/png") {
    if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 4 <= bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      const len = bytes.readUInt16BE(i + 2);
      if (len < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (i + 9 > bytes.length) return null;
        const height = bytes.readUInt16BE(i + 5);
        const width = bytes.readUInt16BE(i + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}

export type ValidLogo = { mime: LogoMime; width: number; height: number };

export function validateLogo(bytes: Buffer): ValidLogo {
  const invalid = (why: string) =>
    new ExpectedToolError("google_ads_demand_gen_logo_invalid", `The logo cannot be used for a Demand Gen ad: ${why}`);
  if (bytes.length === 0) throw invalid("the file is empty.");
  if (bytes.length > LOGO_MAX_BYTES) throw invalid(`it is ${bytes.length} bytes; the limit is ${LOGO_MAX_BYTES}.`);
  const mime = sniffLogoMime(bytes);
  if (!mime) throw invalid("it is not a PNG or JPEG image.");
  const dims = imageDimensions(bytes);
  if (!dims) throw invalid("its size could not be read from the file.");
  const { width, height } = dims;
  if (width < LOGO_MIN_SIDE || height < LOGO_MIN_SIDE) {
    throw invalid(`it is ${width}x${height}; it must be at least ${LOGO_MIN_SIDE}x${LOGO_MIN_SIDE}.`);
  }
  if (Math.abs(width - height) / Math.max(width, height) > 0.01) {
    throw invalid(`it is ${width}x${height}; it must be square (1:1, within 1%).`);
  }
  return { mime, width, height };
}

export type ResolvedAddress = { address: string; family: number };
export type PinnedFetchDeps = {
  lookup?: (host: string) => Promise<ResolvedAddress[]>;
  request?: typeof https.request;
  deadlineMs?: number;
  what?: string;
};

export function isForbiddenAddress(ip: string): boolean {
  if (isPrivateIp(ip)) return true;
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l.startsWith("64:ff9b:") || l.startsWith("2002:") || /^2001:0{0,4}:/.test(l)) return true;
    if (/^::(\d{1,3}\.){3}\d{1,3}$/.test(l)) return true;
  }
  return false;
}

async function defaultLookup(host: string): Promise<ResolvedAddress[]> {
  return dnsLookup(host, { all: true, verbatim: true });
}

export async function pinnedFetch(
  rawUrl: string,
  deps: PinnedFetchDeps = {},
): Promise<{ bytes: Buffer; content_type: string }> {
  const what = deps.what ?? "logo";
  const refused = (why: string) =>
    new ExpectedToolError("google_ads_demand_gen_logo_url_refused", `Zavi will not fetch that ${what} URL: ${why}`);
  const fetchFailed = (why: string) =>
    new ExpectedToolError("google_ads_demand_gen_logo_fetch_failed", `The ${what} could not be downloaded: ${why}`);
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw refused("it is not a valid URL.");
  }
  if (u.protocol !== "https:") throw refused("only https URLs are allowed.");
  if (u.username || u.password) throw refused("a URL with a user name or password is not allowed.");
  if (u.port && u.port !== "443") throw refused("only the standard https port (443) is allowed.");
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!host) throw refused("it has no host.");

  const deadlineMs = deps.deadlineMs ?? FETCH_DEADLINE_MS;
  const startedAt = Date.now();
  let addrs: ResolvedAddress[];
  if (net.isIP(host)) {
    addrs = [{ address: host, family: net.isIP(host) }];
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      addrs = await Promise.race([
        (deps.lookup ?? defaultLookup)(host),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("dns_deadline")), deadlineMs);
        }),
      ]);
    } catch (e) {
      throw fetchFailed(
        (e as Error).message === "dns_deadline"
          ? `resolving ${host} took longer than ${deadlineMs / 1000}s.`
          : `the host ${host} could not be resolved.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  if (addrs.length === 0) throw fetchFailed(`the host ${host} has no address.`);
  const bad = addrs.find((a) => isForbiddenAddress(a.address));
  if (bad) throw refused(`${host} points at a private or reserved address.`);
  const vetted = addrs.find((a) => a.family === 4) ?? addrs[0];

  const request = deps.request ?? https.request;
  const remainingMs = deadlineMs - (Date.now() - startedAt);
  if (remainingMs <= 0) throw fetchFailed(`it took longer than ${deadlineMs / 1000}s.`);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, value?: { bytes: Buffer; content_type: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) reject(err);
      else resolve(value!);
    };
    const req = request(
      u,
      {
        method: "GET",
        servername: net.isIP(host) ? undefined : host,
        agent: false,
        headers: { accept: "image/png,image/jpeg;q=0.9", "user-agent": "ZaviAdAssetFetcher/1.0" },
        lookup: ((_hostname: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
          if (options && options.all) cb(null, [{ address: vetted.address, family: vetted.family }]);
          else cb(null, vetted.address, vetted.family);
        }) as unknown as net.LookupFunction,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          req.destroy();
          return finish(refused("it redirects; give the final image URL."));
        }
        if (status !== 200) {
          res.resume();
          req.destroy();
          return finish(fetchFailed(`the server answered HTTP ${status}.`));
        }
        const contentType = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (!contentType.startsWith("image/")) {
          res.resume();
          req.destroy();
          return finish(fetchFailed(`the URL is not an image (${contentType || "no content type"}).`));
        }
        const declared = Number(res.headers["content-length"] ?? NaN);
        if (Number.isFinite(declared) && declared > LOGO_MAX_BYTES) {
          res.resume();
          req.destroy();
          return finish(fetchFailed(`the image is ${declared} bytes; the limit is ${LOGO_MAX_BYTES}.`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > LOGO_MAX_BYTES) {
            req.destroy();
            finish(fetchFailed(`the image is larger than ${LOGO_MAX_BYTES} bytes.`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => finish(null, { bytes: Buffer.concat(chunks), content_type: contentType }));
        res.on("error", (e: Error) => finish(fetchFailed(e.message)));
      },
    );
    const deadline = setTimeout(() => {
      req.destroy();
      finish(fetchFailed(`it took longer than ${deadlineMs / 1000}s.`));
    }, remainingMs);
    req.on("error", (e: Error) => finish(fetchFailed(e.message)));
    req.end();
  });
}

type StorageLike = Pick<ReturnType<ReturnType<typeof tenantStorage>["from"]>, "upload" | "download">;
export type LogoStoreDeps = { bucket?: (tid: TenantId) => StorageLike };

const defaultBucket = (tid: TenantId): StorageLike => tenantStorage(tid).from(AD_ASSETS_BUCKET);

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function logoStoragePath(tid: TenantId, sha256: string, mime: LogoMime): string {
  return `${String(tid).toLowerCase()}/logos/${sha256}.${mime === "image/png" ? "png" : "jpg"}`;
}

export function logoPathBelongsTo(tenantId: string, storagePath: string): boolean {
  return storagePath.startsWith(`${tenantId.toLowerCase()}/logos/`);
}

function isAlreadyExists(error: { message?: string; statusCode?: string | number } | null): boolean {
  if (!error) return false;
  return String(error.statusCode ?? "") === "409" || /already exists|duplicate/i.test(error.message ?? "");
}

export async function storeLogo(tid: TenantId, bytes: Buffer, deps: LogoStoreDeps = {}): Promise<LogoRef> {
  const { mime, width, height } = validateLogo(bytes);
  const sha256 = sha256Hex(bytes);
  const storage_path = logoStoragePath(tid, sha256, mime);
  const { error } = await (deps.bucket ?? defaultBucket)(tid).upload(storage_path, bytes, {
    contentType: mime,
    upsert: false,
  });
  if (error && !isAlreadyExists(error as { message?: string; statusCode?: string | number })) {
    throw new ExpectedToolError("google_ads_demand_gen_logo_store_failed", `The logo could not be saved: ${error.message}`);
  }
  return { storage_path, sha256, mime, width, height };
}

export async function loadLogoBytes(
  tid: TenantId,
  ref: LogoRef,
  deps: LogoStoreDeps = {},
): Promise<{ bytes: Buffer; base64: string }> {
  const mismatch = (why: string) =>
    new ExpectedToolError("google_ads_demand_gen_logo_mismatch", `The stored logo for this card cannot be used: ${why}`);
  if (!logoPathBelongsTo(String(tid), ref.storage_path)) throw mismatch("it belongs to another workspace.");
  if (logoStoragePath(tid, ref.sha256, ref.mime) !== ref.storage_path) throw mismatch("its path does not match its hash.");
  const { data, error } = await (deps.bucket ?? defaultBucket)(tid).download(ref.storage_path);
  if (error || !data) {
    const e = (error ?? {}) as { message?: string; statusCode?: string | number; status?: number };
    const status = String(e.statusCode ?? e.status ?? "");
    if (status === "404" || /not found/i.test(e.message ?? "")) throw mismatch("it is no longer stored.");
    throw new ExpectedToolError(
      "google_ads_demand_gen_logo_unavailable",
      `The stored logo could not be read right now (${e.message ?? "no data"}); try again.`,
    );
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  if (sha256Hex(bytes) !== ref.sha256) throw mismatch("its bytes changed since Google checked them.");
  return { bytes, base64: bytes.toString("base64") };
}
