
function referenceImageUrls(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((u): u is string => typeof u === "string" && u.startsWith("https://")).slice(0, 3)
    : [];
}

export const SITE_SETUP_MARKER_KEY = "site_setup";

export type SiteSetupMarker = {
  v: 1;
  retryable: boolean;
  company_name: string;
  idea: string;
  max_usd: number | null;
  site_name: string | null;
  workspace_name: string | null;
  started_by_user_id: string | null;
  first_build_free: boolean;
  first_site?: boolean;
  reference_images: string[];
  await_look_pick?: boolean;
  site_template?: Record<string, unknown>;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function siteSetupMarker(goal_graph: unknown): SiteSetupMarker | null {
  if (!Array.isArray(goal_graph)) return null;
  for (const n of goal_graph as Array<{ payload?: Record<string, unknown> } | null>) {
    const m = n?.payload?.[SITE_SETUP_MARKER_KEY] as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object" || m.v !== 1) continue;
    const company_name = str(m.company_name);
    const idea = str(m.idea);
    if (!company_name || !idea) return null;
    const max = m.max_usd;
    return {
      v: 1,
      retryable: m.retryable === true,
      company_name,
      idea,
      max_usd: typeof max === "number" && Number.isFinite(max) && max >= 0 ? max : null,
      site_name: str(m.site_name),
      workspace_name: str(m.workspace_name),
      started_by_user_id: str(m.started_by_user_id),
      first_build_free: m.first_build_free === true,
      ...(m.first_site === true ? { first_site: true } : {}),
      reference_images: referenceImageUrls(m.reference_images),
      ...(m.await_look_pick === true ? { await_look_pick: true } : {}),
      ...(m.site_template && typeof m.site_template === "object" && !Array.isArray(m.site_template) ? { site_template: m.site_template as Record<string, unknown> } : {}),
    };
  }
  return null;
}

export function siteSetupRetryable(goal_graph: unknown): boolean {
  return siteSetupMarker(goal_graph)?.retryable === true;
}
