
export const MAX_STRING_BYTES = 512;

export const MAX_EXTRACTION_BYTES = 24 * 1024;

import { byteLength, truncateToBytes } from "./text-caps";

export type CapResult = {
  value: unknown;
  truncated: boolean;
};

export function capExtraction(
  input: unknown,
  opts: { maxStringBytes?: number; maxBytes?: number } = {},
): CapResult {
  const maxStringBytes = opts.maxStringBytes ?? MAX_STRING_BYTES;
  const maxBytes = opts.maxBytes ?? MAX_EXTRACTION_BYTES;

  let truncated = false;
  const capped = walk(input, maxStringBytes, () => {
    truncated = true;
  });

  let value = capped;
  let guard = 0;
  while (serializedBytes(value) > maxBytes && guard < 64) {
    const shrunk = halveLongestArray(value);
    if (!shrunk.changed) break;
    value = shrunk.value;
    truncated = true;
    guard += 1;
  }

  return { value, truncated };
}

function serializedBytes(value: unknown): number {
  try {
    return byteLength(JSON.stringify(value) ?? "");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function walk(node: unknown, maxStringBytes: number, onTrunc: () => void): unknown {
  if (typeof node === "string") {
    const out = truncateToBytes(node, maxStringBytes);
    if (out.length !== node.length) onTrunc();
    return out;
  }
  if (typeof node === "number") return Number.isFinite(node) ? node : null;
  if (typeof node === "boolean" || node === null) return node;
  if (Array.isArray(node)) {
    return node
      .map((v) => walk(v, maxStringBytes, onTrunc))
      .filter((v) => v !== undefined);
  }
  if (typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const w = walk(v, maxStringBytes, onTrunc);
      if (w !== undefined) out[truncateToBytes(k, maxStringBytes)] = w;
    }
    return out;
  }
  return undefined;
}

function halveLongestArray(root: unknown): { value: unknown; changed: boolean } {
  let bestLen = 1;
  let bestPath: (string | number)[] | null = null;

  const visit = (node: unknown, path: (string | number)[]): void => {
    if (Array.isArray(node)) {
      if (node.length > bestLen) {
        bestLen = node.length;
        bestPath = [...path];
      }
      node.forEach((v, i) => visit(v, [...path, i]));
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        visit(v, [...path, k]);
      }
    }
  };
  visit(root, []);

  if (!bestPath) return { value: root, changed: false };

  const clone = structuredCopy(root);
  const target = atPath(clone, bestPath) as unknown[];
  if (!Array.isArray(target)) return { value: root, changed: false };
  target.length = Math.max(1, Math.floor(target.length / 2));
  return { value: clone, changed: true };
}

function structuredCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function atPath(root: unknown, path: (string | number)[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}
