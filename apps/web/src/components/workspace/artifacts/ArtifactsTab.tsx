"use client";

import { useCallback, useMemo, useState } from "react";
import { useWorkspaceLocation } from "../navigation/useWorkspaceLocation";
import {
  readWorkspaceLocation,
  replaceWorkspaceLocation,
} from "../navigation/workspaceRoutes";
import { X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useIsCompact } from "@/lib/responsive";
import { useWorkspace } from "../WorkspaceShell";
import { ArtifactItem } from "./ArtifactItem";
import { formatArtifactDateShort } from "./formatArtifact";
import { ArtifactToolbar } from "./ArtifactToolbar";
import { useTabSwap } from "@/lib/workspace/useTabSwap";
import { ArtifactTypeTabs } from "./ArtifactTypeTabs";
import { ArtifactViewer } from "./ArtifactViewer";
import {
  ArtifactEmpty,
  ArtifactError,
  ArtifactLoading,
} from "./ArtifactStates";
import {
  isArtifactFilter,
  type ArtifactFilter,
  type ArtifactView,
  type SiteArtifact,
} from "./types";
import { filterArtifacts, filterSites, mergeArtifactEntries } from "./filterArtifacts";
import { SiteArtifactItem } from "./SiteArtifactItem";
import { useArtifacts } from "./useArtifacts";

const NO_SITES: SiteArtifact[] = [];

export const MASONRY_CLASS = "columns-[9.5rem] gap-2.5 sm:columns-[11rem]";

export function ArtifactsTab() {
  const location = useWorkspaceLocation();
  const searchParams = new URL(location, "https://workspace.local")
    .searchParams;
  const { openAgentTab, openBuildTab } = useWorkspace();
  const query = searchParams.get("q") ?? "";
  const rawFilter = searchParams.get("artifact_type");
  const filter: ArtifactFilter = isArtifactFilter(rawFilter)
    ? rawFilter
    : "all";
  const compact = useIsCompact();
  const view: ArtifactView =
    !compact && searchParams.get("artifact_view") === "list" ? "list" : "grid";
  const {
    artifacts: allArtifacts,
    sites: allSites = NO_SITES,
    loading,
    error,
    busyId,
    reload,
    rename,
    remove,
    download,
    clearError,
  } = useArtifacts();
  const artifacts = useMemo(
    () => filterArtifacts(allArtifacts, query, filter),
    [allArtifacts, query, filter],
  );
  const sites = useMemo(
    () => filterSites(allSites, query, filter),
    [allSites, query, filter],
  );
  const entries = useMemo(() => mergeArtifactEntries(sites, artifacts), [sites, artifacts]);
  const hasItems = entries.length > 0;
  const titleCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const artifact of artifacts) counts.set(artifact.title, (counts.get(artifact.title) ?? 0) + 1);
    return counts;
  }, [artifacts]);
  const titleIndexes = new Map<string, number>();

  const [viewingId, setViewingId] = useState<string | null>(null);
  const swapRef = useTabSwap<HTMLDivElement>(`${filter}:${view}`);
  const viewing = allArtifacts.find((item) => item.id === viewingId) ?? null;

  const setParam = useCallback((key: string, value: string | null) => {
    const url = new URL(readWorkspaceLocation(), "https://workspace.local");
    const params = url.searchParams;
    if (params.get("tab") !== "artifacts") return;
    if (value) params.set(key, value);
    else params.delete(key);
    replaceWorkspaceLocation(`${url.pathname}?${params.toString()}`);
  }, []);

  const filtered = query.trim().length > 0 || filter !== "all";

  return (
    <div className="min-h-full px-6 pb-10 pt-14 compact:px-4 compact:pt-3 md:px-10">
      <div className="w-full">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <h1 className="shrink-0 text-xl font-semibold tracking-tight text-ink compact:sr-only">
              Artifacts
            </h1>
            <ArtifactToolbar
              query={query}
              filter={filter}
              view={view}
              onQueryChange={(value) => setParam("q", value || null)}
              onFilterChange={(value) =>
                setParam("artifact_type", value === "all" ? null : value)
              }
              onViewChange={(value) =>
                setParam("artifact_view", value === "grid" ? null : value)
              }
            />
          </div>

          <ArtifactTypeTabs
            value={filter}
            onChange={(value) => setParam("artifact_type", value === "all" ? null : value)}
            className="-mx-1 hidden px-1 sm:flex"
          />

          {error && hasItems && (
            <div
              role="alert"
              className="flex items-center gap-3 rounded-xl border border-danger/20 bg-dangerBg px-4 py-3 text-base text-danger"
            >
              <span className="min-w-0 flex-1">{error}</span>
              <Button
                onClick={clearError}
                className="border-0 bg-transparent p-1 text-danger"
                aria-label="Dismiss error"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          )}

          {loading ? (
            <ArtifactLoading view={view} />
          ) : error && !hasItems ? (
            <ArtifactError message={error} onRetry={() => void reload()} />
          ) : !hasItems ? (
            <ArtifactEmpty
              filtered={filtered}
              onCreate={() =>
                void openAgentTab("operator", { newThread: true, push: true })
              }
            />
          ) : (
            <div ref={swapRef} data-testid="artifact-results" className={view === "grid" ? MASONRY_CLASS : "space-y-3"}>
              {entries.map((entry) => {
                if (entry.kind === "site") {
                  const { site } = entry;
                  const sessionId = site.build_session_id;
                  return (
                    <div
                      key={`site:${site.id}`}
                      className={view === "grid" ? "mb-2.5 break-inside-avoid" : undefined}
                    >
                      <SiteArtifactItem
                        site={site}
                        view={view}
                        onOpen={sessionId ? () => openBuildTab(sessionId, { push: true }) : null}
                      />
                    </div>
                  );
                }
                const { artifact } = entry;
                const count = titleCounts.get(artifact.title) ?? 1;
                const index = (titleIndexes.get(artifact.title) ?? 0) + 1;
                titleIndexes.set(artifact.title, index);
                const accessibilityName =
                  count > 1
                    ? `${artifact.title}, ${artifact.type}, ${formatArtifactDateShort(artifact.created_at)}, item ${index} of ${count}`
                    : undefined;
                return (
                <div
                  key={artifact.id}
                  className={view === "grid" ? "mb-2.5 break-inside-avoid" : undefined}
                >
                  <ArtifactItem
                    artifact={artifact}
                    accessibilityName={accessibilityName}
                    view={view}
                    busy={busyId === artifact.id}
                    onOpen={() => setViewingId(artifact.id)}
                    onRename={(title) => rename(artifact.id, title)}
                    onDownload={() => void download(artifact)}
                    onDelete={() => remove(artifact.id)}
                  />
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {viewing && (
        <ArtifactViewer
          artifact={viewing}
          onClose={() => setViewingId(null)}
          onDownload={() => void download(viewing)}
        />
      )}
    </div>
  );
}
