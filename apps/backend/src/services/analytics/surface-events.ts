
import { track } from "./mixpanel";

export const SURFACE_OPEN_SOURCES = ["roster", "summon"] as const;
export type SurfaceOpenSource = (typeof SURFACE_OPEN_SOURCES)[number];

export function parseSurfaceSource(raw: unknown): SurfaceOpenSource {
  return raw === "summon" ? "summon" : "roster";
}

export function trackSurfaceOpened(args: {
  tenant_id: string;
  user_id: string;
  agent_slug: string;
  source: SurfaceOpenSource;
}): void {
  try {
    track("agent_surface_opened", {
      tenant_id: args.tenant_id,
      user_id: args.user_id,
      agent_slug: args.agent_slug,
      source: args.source,
    });
  } catch {
  }
}

export function trackSurfaceSummoned(args: {
  tenant_id: string;
  agent_slug: string;
  surface_key: string;
  dashboard_slug: string;
}): void {
  try {
    track("agent_surface_summoned", {
      tenant_id: args.tenant_id,
      agent_slug: args.agent_slug,
      surface_key: args.surface_key,
      dashboard_slug: args.dashboard_slug,
    });
  } catch {
  }
}
