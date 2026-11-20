
import type { SiteRepoRunCheck } from "@/services/sites/site-build-target";
import { BuilderPolicyRefusedError } from "@/services/agents/run-failure-code";

const COPY_PATHS = 5;

export type ForbiddenPathRefusal = {
  paths: string[];
  output_text: string;
  stageError: BuilderPolicyRefusedError | null;
};

export function isConductorBuildStage(payload: unknown): boolean {
  const p = (payload ?? {}) as { stage?: unknown; build_conductor_run_id?: unknown };
  return (
    (p.stage === "scaffold" || p.stage === "build") &&
    typeof p.build_conductor_run_id === "string" &&
    p.build_conductor_run_id.trim().length > 0
  );
}

function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, COPY_PATHS).join(", ");
  const more = paths.length - COPY_PATHS;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

function founderCopy(paths: readonly string[], siteCheck: SiteRepoRunCheck | null, stage: boolean): string {
  const list = listPaths(paths);
  const retry = stage ? "Retry the build." : "Ask again once that is fixed.";
  if (siteCheck && !siteCheck.ok && siteCheck.reason === "not_buildable") {
    return `This site's build was stopped while this step was still working, so its changes (${list}) were not published. ${retry}`;
  }
  if (siteCheck && !siteCheck.ok && siteCheck.reason === "read_error") {
    return `Zavi couldn't confirm this site while publishing, so its changes (${list}) were not published. ${retry}`;
  }
  return stage
    ? `This build changed files Zavi never publishes (${list}), so nothing was published. Retry the build; if it happens again, contact support.`
    : `I made changes in the sandbox but the platform refused to ship them: forbidden_path. Zavi never publishes these files: ${list}. Nothing was shipped; remove those changes and ask again.`;
}

export function forbiddenPathRefusal(input: {
  detail: { path: string; paths?: string[] };
  siteCheck: SiteRepoRunCheck | null;
  payload: unknown;
  tenant_id: string;
  run_id: string | null | undefined;
  repo: string | null;
}): ForbiddenPathRefusal {
  const paths = input.detail.paths?.length ? [...input.detail.paths] : [input.detail.path];
  const siteExemption = input.siteCheck === null
    ? "not_a_site_run"
    : input.siteCheck.ok
      ? "applied"
      : `not_applied:${input.siteCheck.reason}${input.siteCheck.status ? `:${input.siteCheck.status}` : ""}`;
  const stage = isConductorBuildStage(input.payload);
  console.warn(
    `[engineer post-run] builder refused forbidden_path ${JSON.stringify({
      tenant_id: input.tenant_id,
      run_id: input.run_id ?? null,
      repo: input.repo,
      paths,
      site_exemption: siteExemption,
      conductor_stage: stage,
    })}`,
  );
  const copy = founderCopy(paths, input.siteCheck, stage);
  return {
    paths,
    output_text: copy,
    stageError: stage ? new BuilderPolicyRefusedError(paths, copy) : null,
  };
}
