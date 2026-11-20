
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function truncateToBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLength(s) <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(s.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let out = s.slice(0, lo);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}
