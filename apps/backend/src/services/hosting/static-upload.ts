
import type { SandboxExec, StaticFetch } from "./static-publish";

export const STATIC_UPLOAD_CONCURRENCY = 8;

const CF = "https://api.cloudflare.com/client/v4";

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  rsc: "text/x-component; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
  wasm: "application/wasm",
  zip: "application/zip",
};

const TEXT_EXTS = new Set([
  "html", "htm", "css", "js", "mjs", "json", "map", "txt", "xml", "webmanifest", "rsc", "svg",
]);

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extOf(path)] ?? "application/octet-stream";
}

function toBytes(path: string, raw: Buffer | string): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  return TEXT_EXTS.has(extOf(path)) ? Buffer.from(raw, "utf8") : Buffer.from(raw, "base64");
}

function tail(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? t.slice(-n) : t;
}

export async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<string | null> {
  let next = 0;
  let failure: string | null = null;
  const worker = async (): Promise<void> => {
    while (failure === null && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (e) {
        if (failure === null) failure = (e as Error).message;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return failure;
}

export function r2ObjectUrl(accountId: string, bucket: string, key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${CF}/accounts/${accountId}/r2/buckets/${bucket}/objects/${encodedKey}`;
}

export type UploadStaticDirectoryInput = {
  sandbox: Pick<SandboxExec, "readFile">;
  root: string;
  files: string[];
  keyPrefix: string;
  accountId: string;
  bucket: string;
  token: string;
  fetchFn: StaticFetch;
  concurrency?: number;
};

export async function uploadStaticDirectory(input: UploadStaticDirectoryInput): Promise<string | null> {
  const { sandbox, root, keyPrefix, accountId, bucket, token, fetchFn } = input;
  const uploadOne = async (rel: string): Promise<void> => {
    let raw: Buffer | string;
    try {
      raw = await sandbox.readFile(`${root}/${rel}`);
    } catch (e) {
      throw new Error(`read ${rel}: ${(e as Error).message}`);
    }
    const body = toBytes(rel, raw);
    const url = r2ObjectUrl(accountId, bucket, `${keyPrefix}${rel}`);
    let last = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchFn(url, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": contentTypeFor(rel) },
          body: new Uint8Array(body),
        });
        if (res.status >= 200 && res.status < 300) return;
        last = `upload ${rel} failed (${res.status}): ${tail(await res.text().catch(() => ""), 300)}`;
        if (res.status < 500 && res.status !== 429) break;
      } catch (e) {
        last = `upload ${rel} failed: ${(e as Error).message}`;
      }
    }
    throw new Error(last);
  };
  return mapPool(input.files, input.concurrency ?? STATIC_UPLOAD_CONCURRENCY, uploadOne);
}
