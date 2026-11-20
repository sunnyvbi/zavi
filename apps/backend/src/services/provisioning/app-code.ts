import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { stripPickerFromExport } from "./picker-asset";

const GH = "https://api.github.com";

export const APP_CODE_MAX_FILE_BYTES = 400_000;

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export type AppCodeEntry = { path: string; type: "file" | "dir"; size?: number; sha?: string };

export type AppCodeFile =
  | { path: string; kind: "text"; content: string; size: number }
  | { path: string; kind: "binary" | "too_large"; size: number };

export class AppCodePathRefused extends Error {
  constructor(readonly reason: "invalid_path" | "secret_file") {
    super(reason);
  }
}

export class AppCodeNotFound extends Error {}

export function isSecretPath(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  if (!/^\.env(rc|\..+)?$/i.test(base)) return false;
  return !/^\.env\.(example|sample|template)$/i.test(base);
}

export function isValidCodePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 400) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export async function listAppCodeTree(
  args: { full_name: string; branch: string; token: string },
  fetchFn: FetchLike = (globalThis as { fetch: FetchLike }).fetch,
): Promise<{ entries: AppCodeEntry[]; truncated: boolean }> {
  const res = await fetchFn(
    `${GH}/repos/${args.full_name}/git/trees/${encodeURIComponent(args.branch)}?recursive=1`,
    { headers: headers(args.token) },
  );
  if (res.status === 404) throw new AppCodeNotFound(args.full_name);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`app code tree failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as {
    tree?: Array<{ path: string; type: string; size?: number; mode?: string; sha?: string }>;
    truncated?: boolean;
  };
  const entries: AppCodeEntry[] = [];
  for (const e of body.tree ?? []) {
    if (e.type === "tree") entries.push({ path: e.path, type: "dir" });
    else if (e.type === "blob" && e.mode !== "120000" && !isSecretPath(e.path)) {
      entries.push({ path: e.path, type: "file", size: e.size, ...(typeof e.sha === "string" ? { sha: e.sha } : {}) });
    }
  }
  return { entries, truncated: !!body.truncated };
}

export async function readAppCodeFile(
  args: { full_name: string; branch: string; token: string; path: unknown },
  fetchFn: FetchLike = (globalThis as { fetch: FetchLike }).fetch,
): Promise<AppCodeFile> {
  if (!isValidCodePath(args.path)) throw new AppCodePathRefused("invalid_path");
  const path = args.path;
  if (isSecretPath(path)) throw new AppCodePathRefused("secret_file");
  const res = await fetchFn(
    `${GH}/repos/${args.full_name}/contents/${encodePath(path)}?ref=${encodeURIComponent(args.branch)}`,
    { headers: headers(args.token) },
  );
  if (res.status === 404) throw new AppCodeNotFound(path);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`app code file failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as {
    path?: string;
    type?: string;
    size?: number;
    content?: string;
    encoding?: string;
  };
  if (body.type !== "file" || (typeof body.path === "string" && body.path !== path)) {
    throw new AppCodeNotFound(path);
  }
  const size = body.size ?? 0;
  if (size > APP_CODE_MAX_FILE_BYTES || body.encoding !== "base64" || typeof body.content !== "string") {
    return { path, kind: size > APP_CODE_MAX_FILE_BYTES ? "too_large" : "binary", size };
  }
  const bytes = Buffer.from(body.content, "base64");
  if (bytes.includes(0)) return { path, kind: "binary", size };
  return { path, kind: "text", content: bytes.toString("utf8"), size };
}

export const APP_CODE_ZIP_MAX_BYTES = 25 * 1024 * 1024;
export const APP_CODE_ZIP_MAX_FILES = 3000;

export class AppCodeTooLarge extends Error {}

type ArchiveFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}>;

const MODE_ATTRS: Record<string, number> = {
  "100644": 0o100644 << 16,
  "100755": 0o100755 << 16,
  "120000": 0o120777 << 16,
};

async function readCapped(body: ReadableStream<Uint8Array> | null | undefined, cap: number, abort: () => void): Promise<Uint8Array> {
  if (!body) throw new Error("app code archive had no body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      abort();
      await reader.cancel().catch(() => undefined);
      throw new AppCodeTooLarge("archive over the size cap");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export async function buildAppCodeZip(
  args: { full_name: string; branch: string; token: string },
  fetchFn: ArchiveFetch = (globalThis as { fetch: ArchiveFetch }).fetch,
): Promise<{ zip: Uint8Array; filename: string; file_count: number }> {
  const h = headers(args.token);
  const commitRes = await fetchFn(`${GH}/repos/${args.full_name}/commits/${encodeURIComponent(args.branch)}`, { headers: h });
  if (commitRes.status === 404 || commitRes.status === 422) throw new AppCodeNotFound(args.full_name);
  if (commitRes.status < 200 || commitRes.status >= 300) {
    throw new Error(`app code commit failed (${commitRes.status}): ${await commitRes.text()}`);
  }
  const sha = (await commitRes.json()) as { sha?: unknown };
  if (typeof sha.sha !== "string" || !/^[0-9a-f]{40}$/.test(sha.sha)) throw new Error("app code commit had no sha");

  const treeRes = await fetchFn(`${GH}/repos/${args.full_name}/git/trees/${sha.sha}?recursive=1`, { headers: h });
  if (treeRes.status === 404) throw new AppCodeNotFound(args.full_name);
  if (treeRes.status < 200 || treeRes.status >= 300) {
    throw new Error(`app code tree failed (${treeRes.status}): ${await treeRes.text()}`);
  }
  const tree = (await treeRes.json()) as {
    tree?: Array<{ path?: unknown; type?: unknown; mode?: unknown; size?: unknown }>;
    truncated?: boolean;
  };
  if (tree.truncated) throw new AppCodeTooLarge(args.full_name);
  const wanted = new Map<string, { mode: string; size: number }>();
  let total = 0;
  let blobs = 0;
  for (const e of tree.tree ?? []) {
    if (e.type !== "blob" || typeof e.path !== "string" || typeof e.mode !== "string") continue;
    const size = typeof e.size === "number" && e.size >= 0 ? e.size : 0;
    total += size;
    blobs++;
    if (!isValidCodePath(e.path) || isSecretPath(e.path)) continue;
    wanted.set(e.path, { mode: e.mode, size });
  }
  if (wanted.size === 0) throw new AppCodeNotFound(args.full_name);
  if (blobs > APP_CODE_ZIP_MAX_FILES || total > APP_CODE_ZIP_MAX_BYTES) throw new AppCodeTooLarge(args.full_name);

  const controller = new AbortController();
  const archiveRes = await fetchFn(`${GH}/repos/${args.full_name}/zipball/${sha.sha}`, { headers: h, signal: controller.signal });
  if (archiveRes.status === 404) throw new AppCodeNotFound(args.full_name);
  if (archiveRes.status < 200 || archiveRes.status >= 300) {
    throw new Error(`app code archive failed (${archiveRes.status}): ${await archiveRes.text()}`);
  }
  const archive = await readCapped(archiveRes.body, total + blobs * 512 + 1024 * 1024, () => controller.abort());

  const pathOf = (name: string) => {
    const slash = name.indexOf("/");
    return slash === -1 ? "" : name.slice(slash + 1);
  };
  const unpacked = unzipSync(archive, {
    filter: (f) => {
      const want = wanted.get(pathOf(f.name));
      return !!want && f.originalSize <= want.size;
    },
  });
  const files = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(unpacked)) files.set(pathOf(name), bytes);

  const owned = stripPickerFromExport(files, { decode: (b) => strFromU8(b), encode: (s) => strToU8(s) });
  const root = args.full_name.split("/").pop() || "app";
  const out: Zippable = {};
  for (const [path, bytes] of owned) {
    const attrs = MODE_ATTRS[wanted.get(path)?.mode ?? ""] ?? MODE_ATTRS["100644"]!;
    out[`${root}/${path}`] = [bytes, { os: 3, attrs }];
  }
  return { zip: zipSync(out, { level: 1 }), filename: `${root}.zip`, file_count: owned.size };
}
