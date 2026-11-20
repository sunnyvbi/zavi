
import { BUILD_CHECKS_FAILED, BUILD_PUBLISH_FAILED } from "@zavi/shared";
import { publishReason, sitePublishState } from "@/services/build/app-ready";
import { websiteUrl } from "@/services/web-base";
import type { SiteRow } from "./contract";

export const CUSTOM_DOMAINS_INFO = {
  workspace_app: {
    available: true,
    where:
      "In Zavi: Website tab, then Domains. An owner or admin adds a domain they own there and sets the DNS record it shows at their registrar.",
    api: "/api/website/custom-domains",
  },
  site: {
    available: false,
    where: "Not yet: a site's Domains view in the Website tab says custom domains are coming soon. It keeps its Zavi address.",
  },
} as const;

export function customDomainsFor(kinds: { workspace_app: boolean; site: boolean }): Partial<typeof CUSTOM_DOMAINS_INFO> {
  return {
    ...(kinds.workspace_app ? { workspace_app: CUSTOM_DOMAINS_INFO.workspace_app } : {}),
    ...(kinds.site ? { site: CUSTOM_DOMAINS_INFO.site } : {}),
  };
}

const GATE_FAILURE_RE = /^(?:The site's smoke check failed:|gate:|check:)/;

export type SitePublishRunRow = {
  id: string;
  status: string | null;
  created_at: string | null;
  failure_class: string | null;
  failure_reason: string | null;
};

export type SitePreviewRow = { repo_full_name: string; preview_url: string | null; preview_status: string | null };

export type SitePublishReads = {
  publishRuns(tenant_id: string, ids: string[]): Promise<SitePublishRunRow[]>;
  previews(tenant_id: string, repos: string[]): Promise<SitePreviewRow[]>;
  probe(url: string): Promise<"ok" | "compiling" | "dead" | string>;
};

export type SitePublishState = {
  pending: boolean;
  live_version: string | null;
  latest_version: string | null;
  publish_status: "publishing" | "failed" | "none" | null;
  last_problem: string | null;
  previous_version_still_live: boolean;
  preview_url: string | null;
  preview_checked: boolean;
  open_in_zavi: string;
};

const short = (sha: string | null | undefined): string | null =>
  typeof sha === "string" && sha.trim() ? sha.trim().slice(0, 7) : null;

const isPending = (site: SiteRow): boolean => !!site.desired_sha && site.desired_sha !== site.live_sha;

export function sitePublishNeedsState(site: SiteRow): boolean {
  return isPending(site) || !!(site.last_error && site.last_error.trim());
}

function stoppedLine(raw: string | null | undefined): string {
  return typeof raw === "string" && GATE_FAILURE_RE.test(raw.trim()) ? BUILD_CHECKS_FAILED : BUILD_PUBLISH_FAILED;
}

async function settle<T>(what: string, tenant_id: string, p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    console.warn(`[site-publish-state] event=read_failed what=${what} tenant=${tenant_id} error=${(e as Error).message ?? e}`);
    return null;
  }
}

export async function sitePublishStates(
  tenant_id: string,
  sites: readonly SiteRow[],
  reads: SitePublishReads,
): Promise<Map<string, SitePublishState>> {
  const wanted = sites.filter(sitePublishNeedsState);
  const out = new Map<string, SitePublishState>();
  if (wanted.length === 0) return out;
  const runIds = [...new Set(wanted.flatMap((s) => (s.publish_run_id ? [s.publish_run_id] : [])))];
  const repos = [...new Set(wanted.filter(isPending).flatMap((s) => (s.github_full_name ? [s.github_full_name] : [])))];
  const [runs, previews] = await Promise.all([
    runIds.length ? settle("publish_runs", tenant_id, reads.publishRuns(tenant_id, runIds)) : Promise.resolve([]),
    repos.length ? settle("previews", tenant_id, reads.previews(tenant_id, repos)) : Promise.resolve([]),
  ]);
  const runById = new Map((runs ?? []).map((r) => [r.id, r]));
  const previewByRepo = new Map((previews ?? []).map((p) => [p.repo_full_name, p]));
  const openInZavi = websiteUrl(tenant_id);

  await Promise.all(
    wanted.map(async (site) => {
      const pending = isPending(site);
      let publish_status: SitePublishState["publish_status"] = null;
      let last_problem: string | null = null;
      if (runs !== null) {
        const run = site.publish_run_id ? runById.get(site.publish_run_id) ?? null : null;
        const st = sitePublishState({
          site_status: site.status,
          site_updated_at: site.updated_at,
          run: run ? { status: run.status, created_at: run.created_at, reason: run.failure_reason, failure_class: run.failure_class } : null,
        });
        publish_status = st.status === "live" ? "none" : st.status;
        if (st.status === "failed") last_problem = st.reason ?? stoppedLine(run?.failure_reason ?? site.last_error);
        else if (st.status === "none" && site.last_error?.trim()) {
          last_problem = publishReason(site.last_error, null) ?? stoppedLine(site.last_error);
        }
      }
      let preview_url: string | null = null;
      let preview_checked = !pending || previews !== null;
      const row = pending && site.github_full_name ? previewByRepo.get(site.github_full_name) : undefined;
      if (row?.preview_status === "live" && row.preview_url) {
        const state = await reads.probe(row.preview_url).catch(() => null);
        if (state === null) preview_checked = false;
        else if (state === "ok" || state === "live" || state === "compiling") preview_url = row.preview_url;
      }
      out.set(site.id, {
        pending,
        live_version: short(site.live_sha),
        latest_version: short(site.desired_sha),
        publish_status,
        last_problem,
        previous_version_still_live: pending && !!site.live_sha && site.status === "live",
        preview_url,
        preview_checked,
        open_in_zavi: openInZavi,
      });
    }),
  );
  return out;
}
