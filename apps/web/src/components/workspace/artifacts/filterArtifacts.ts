import type { Artifact, ArtifactFilter, SiteArtifact } from "./types";

export function filterArtifacts<T extends Pick<Artifact, "type" | "title" | "filename">>(
  artifacts: T[],
  query: string,
  filter: ArtifactFilter,
): T[] {
  const q = query.trim().slice(0, 120).toLocaleLowerCase("en-US");
  if (!q && filter === "all") return artifacts;
  return artifacts.filter((artifact) => {
    if (filter !== "all" && artifact.type !== filter) return false;
    if (!q) return true;
    return `${artifact.title ?? ""}\n${artifact.filename}`
      .toLocaleLowerCase("en-US")
      .includes(q);
  });
}

const IN_PROGRESS_SITE: ReadonlySet<string> = new Set(["provisioning", "building", "publishing"]);

export function isFinishedSite(site: SiteArtifact): boolean {
  if (site.status === "failed") return false;
  if (IN_PROGRESS_SITE.has(site.status)) return !!site.built && site.status !== "publishing";
  return true;
}

export function filterSites(sites: SiteArtifact[], query: string, filter: ArtifactFilter): SiteArtifact[] {
  if (filter !== "all" && filter !== "website") return [];
  const q = query.trim().slice(0, 120).toLocaleLowerCase("en-US");
  return sites.filter(
    (site) => isFinishedSite(site) && (!q || `${site.title}\n${site.hostname}`.toLocaleLowerCase("en-US").includes(q)),
  );
}

export type ArtifactEntry =
  | { kind: "site"; at: number; site: SiteArtifact }
  | { kind: "file"; at: number; artifact: Artifact };

export function mergeArtifactEntries(
  sites: SiteArtifact[],
  artifacts: Artifact[],
): ArtifactEntry[] {
  const at = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
  };
  const entries: ArtifactEntry[] = [
    ...sites.map((site) => ({ kind: "site" as const, at: at(site.created_at), site })),
    ...artifacts.map((artifact) => ({ kind: "file" as const, at: at(artifact.created_at), artifact })),
  ];
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.at - a.entry.at || a.index - b.index)
    .map(({ entry }) => entry);
}
