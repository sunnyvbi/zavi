export function parseAmount(raw: string, max?: number): string | null {
  let s = raw.trim().replace(/^(us\s*\$|usd|\$)\s*/i, "").replace(/\s*(usd|us\s*dollars?|dollars?)$/i, "").trim();
  let mult = 1;
  if (/k$/i.test(s)) {
    mult = 1000;
    s = s.slice(0, -1).trim();
  }
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(Number(s) * mult * 100) / 100;
  if (!Number.isFinite(n) || n >= 1e15) return null;
  if (max !== undefined && n > max) return null;
  return String(n);
}
