
const KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_LABEL_LEN = 60;

export type SummonedSurfaceRef = {
  key: string;
  dashboardSlug: string;
  label: string;
};

export function readSummonedSurface(meta: unknown): SummonedSurfaceRef | null {
  if (!meta || typeof meta !== "object") return null;
  const raw = (meta as Record<string, unknown>).summoned_surface;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r.key === "string" ? r.key : "";
  const dashboardSlug =
    typeof r.dashboard_slug === "string" ? r.dashboard_slug : "";
  const label = typeof r.label === "string" ? r.label.trim() : "";
  if (!KEY_RE.test(key)) return null;
  if (!KEY_RE.test(dashboardSlug)) return null;
  if (label.length === 0) return null;
  return { key, dashboardSlug, label: label.slice(0, MAX_LABEL_LEN) };
}
