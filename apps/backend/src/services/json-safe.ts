
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const NUL = /\u0000/g;

export function wellFormed(s: string): string {
  return s.replace(LONE_SURROGATE, "�").replace(NUL, "");
}

export function sliceWhole(s: string, end: number): string {
  if (end <= 0) return "";
  if (end >= s.length) return s;
  const last = s.charCodeAt(end - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function toJsonSafe<T>(value: T): T {
  if (typeof value === "string") return wellFormed(value) as T;
  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v)) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = wellFormed(k.replace(NUL, "\uFFFD"));
      Object.defineProperty(out, key, { value: toJsonSafe(v), enumerable: true, writable: true, configurable: true });
    }
    return out as T;
  }
  return value;
}
