import type { CodeToken } from "./codeHighlight";

export type CodeEntry = { path: string; type: "file" | "dir"; size?: number; sha?: string };

export type CachedTree = { entries: CodeEntry[]; truncated: boolean; branch: string; name: string };

export type CachedFile = { status: "text"; content: string } | { status: "binary" | "too_large" };

export type CachedView = { openTabs: string[]; active: string | null; expanded: string[] };

const MAX_FILES = 300;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOKENS = 120;

const trees = new Map<string, CachedTree>();
const views = new Map<string, CachedView>();
const files = new Map<string, CachedFile>();
let fileBytes = 0;
const tokens = new Map<string, CodeToken[][] | null>();

function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function readCachedTree(scope: string | null | undefined): CachedTree | null {
  return scope ? trees.get(scope) ?? null : null;
}

export function writeCachedTree(scope: string | null | undefined, tree: CachedTree): void {
  if (scope) trees.set(scope, tree);
}

export function readCachedView(scope: string | null | undefined): CachedView | null {
  return scope ? views.get(scope) ?? null : null;
}

export function writeCachedView(scope: string | null | undefined, view: CachedView): void {
  if (scope) views.set(scope, view);
}

export function fileBytesOf(file: CachedFile): number {
  return file.status === "text" ? file.content.length * 2 : 0;
}

function forgetFile(sha: string): void {
  const file = files.get(sha);
  if (!file) return;
  fileBytes -= fileBytesOf(file);
  files.delete(sha);
}

export function cachedFileBytes(): number {
  return fileBytes;
}

export function readCachedFile(sha: string | undefined): CachedFile | null {
  if (!sha) return null;
  const file = files.get(sha);
  if (!file) return null;
  files.delete(sha);
  files.set(sha, file);
  return file;
}

export function writeCachedFile(sha: string | undefined, file: CachedFile): void {
  if (!sha) return;
  const size = fileBytesOf(file);
  forgetFile(sha);
  if (size > MAX_FILE_BYTES) return;
  files.set(sha, file);
  fileBytes += size;
  while (files.size > MAX_FILES || fileBytes > MAX_FILE_BYTES) {
    const oldest = files.keys().next().value;
    if (oldest === undefined) break;
    forgetFile(oldest);
  }
}

function tokenKey(path: string, sha: string): string {
  return `${sha}\u0000${path}`;
}

export function hasCachedTokens(path: string, sha: string | undefined): boolean {
  return !!sha && tokens.has(tokenKey(path, sha));
}

export function readCachedTokens(path: string, sha: string | undefined): CodeToken[][] | null {
  return sha ? tokens.get(tokenKey(path, sha)) ?? null : null;
}

export function writeCachedTokens(path: string, sha: string | undefined, value: CodeToken[][] | null): void {
  if (sha) remember(tokens, tokenKey(path, sha), value, MAX_TOKENS);
}

export function sameEntries(a: CodeEntry[], b: CodeEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => entry.path === b[i]!.path && entry.type === b[i]!.type && entry.sha === b[i]!.sha);
}

export function clearAppCodeCache(): void {
  trees.clear();
  views.clear();
  files.clear();
  fileBytes = 0;
  tokens.clear();
}
