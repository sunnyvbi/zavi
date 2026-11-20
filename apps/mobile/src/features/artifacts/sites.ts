import type { Artifact, ArtifactFilter, SiteArtifact } from "./types";

const IN_PROGRESS_SITE: ReadonlySet<string> = new Set(["provisioning", "building", "publishing"]);
const UNPUBLISHED_SITE: ReadonlySet<string> = new Set(["provisioning", "building"]);

export function isFinishedSite(site: SiteArtifact): boolean {
  if (site.status === "failed") return false;
  if (IN_PROGRESS_SITE.has(site.status)) return !!site.built && site.status !== "publishing";
  return true;
}

export function visibleSites(sites: SiteArtifact[], filter: ArtifactFilter): SiteArtifact[] {
  if (filter !== "all" && filter !== "website") return [];
  return sites.filter(isFinishedSite);
}

export type SiteBadgeTone = "success" | "muted" | "progress" | "danger";

export function siteBadge(site: SiteArtifact): { label: string; tone: SiteBadgeTone } | null {
  if (site.built && !site.live_url && UNPUBLISHED_SITE.has(site.status)) return { label: "Not published", tone: "muted" };
  switch (site.status) {
    case "live":
      return { label: "Live", tone: "success" };
    case "provisioning":
    case "building":
    case "publishing":
      return { label: "Building", tone: "progress" };
    case "paused":
    case "waking":
      return { label: "Paused", tone: "muted" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    default:
      return null;
  }
}

export function siteHref(site: SiteArtifact): string | null {
  const url = site.live_url;
  return typeof url === "string" && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null;
}

export type ArtifactEntry =
  | { kind: "site"; key: string; at: number; site: SiteArtifact }
  | { kind: "file"; key: string; at: number; artifact: Artifact };

export function mergeArtifactEntries(sites: SiteArtifact[], artifacts: Artifact[]): ArtifactEntry[] {
  const at = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
  };
  const entries: ArtifactEntry[] = [
    ...sites.map((site) => ({ kind: "site" as const, key: `site:${site.id}`, at: at(site.created_at), site })),
    ...artifacts.map((artifact) => ({ kind: "file" as const, key: artifact.id, at: at(artifact.created_at), artifact })),
  ];
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.at - a.entry.at || a.index - b.index)
    .map(({ entry }) => entry);
}
