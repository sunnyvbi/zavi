export const NEXT_CHUNK_RELOAD_STORAGE_KEY = "zavi:next-chunk-reload-at";

const NEXT_CHUNK_PATTERNS = [
  /ChunkLoadError/i,
  /Loading chunk \d+ failed/i,
  /Loading CSS chunk \d+ failed/i,
  /_next\/static\/chunks\//i,
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
];

function errorLikeText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    return [value.name, value.message, value.stack].filter(Boolean).join("\n");
  }
  if (typeof value !== "object") return String(value);

  const record = value as Record<string, unknown>;
  const fields = [
    "name",
    "message",
    "stack",
    "filename",
    "request",
    "src",
    "href",
  ];
  return fields
    .map((field) => record[field])
    .filter((part): part is string | number => typeof part === "string" || typeof part === "number")
    .join("\n");
}

export function isNextChunkLoadFailure(value: unknown): boolean {
  const text = errorLikeText(value);
  return NEXT_CHUNK_PATTERNS.some((pattern) => pattern.test(text));
}

export function shouldReloadForChunkFailure(
  nowMs: number,
  lastReloadAt: string | null,
  minIntervalMs: number,
): boolean {
  const last = lastReloadAt ? Number(lastReloadAt) : 0;
  if (!Number.isFinite(last) || last <= 0) return true;
  return nowMs - last >= minIntervalMs;
}
