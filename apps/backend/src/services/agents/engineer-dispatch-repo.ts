
export const ENGINEER_NO_REPO_REASON = "engineer_no_repo";
export const ENGINEER_NO_REPO_NOTE = "Connect GitHub so I can fix the site.";

type EngineerDispatchBody = { target_agent_slug: "engineer"; repo_hint?: unknown; site_id?: unknown };

export function isEngineerDispatch(decision_class: string, body: unknown): body is EngineerDispatchBody {
  return (
    decision_class.endsWith(".dispatch-specialist") &&
    !!body &&
    typeof body === "object" &&
    (body as { target_agent_slug?: unknown }).target_agent_slug === "engineer"
  );
}

export type EngineerRepo = { repo?: string; site_id?: string } | null;

export async function withEngineerRepo<T>(
  decision_class: string,
  body: T,
  resolveRepo: (hint?: string) => Promise<EngineerRepo>,
): Promise<T | null> {
  if (!isEngineerDispatch(decision_class, body)) return body;
  const hint = typeof body.repo_hint === "string" ? body.repo_hint.trim() : undefined;
  const target = await resolveRepo(hint || undefined);
  if (!target) return null;
  if (!target.repo) return body;
  if (body.site_id !== undefined && body.site_id !== target.site_id) return null;
  return { ...body, repo_hint: target.repo, ...(target.site_id ? { site_id: target.site_id } : {}) };
}

export async function resolveEngineerDispatchRepo(tenant_id: string, hint?: string): Promise<EngineerRepo> {
  try {
    const { siteForRepo, defaultSiteForTenant, GONE_SITE_STATUSES } = await import("@/services/sites/app-identity");
    const withSite = async (repo: string): Promise<EngineerRepo> => {
      const site = await siteForRepo(tenant_id, repo);
      if (!site) return { repo };
      if (GONE_SITE_STATUSES.has(site.status) || site.status === "failed") return null;
      return { repo, site_id: site.id };
    };
    const { resolveRepoFullName } = await import("@/services/agents/repo-resolver");
    const checked = async (repo: string) => withSite(await resolveRepoFullName(
      { tenant_id, repo_hint: repo }, { throwOnReadError: true },
    ));
    if (hint) return await checked(hint);
    const { resolveContentSeoPublishRepo } = await import("@/agents/content-design/post-run");
    const options = { throwOnReadError: true };
    const one = await resolveContentSeoPublishRepo(tenant_id, options);
    if (one) return await checked(one.repo);
    const { getScopedRepoFullNames } = await import("@/services/connectors/github/scoped-repos");
    if ((await getScopedRepoFullNames(tenant_id, undefined, options)).length > 0) return {};
    const site = await defaultSiteForTenant(tenant_id);
    const repo = site?.github_full_name?.trim();
    if (!site || !repo) return null;
    const target = await checked(repo);
    return target?.site_id === site.id ? target : null;
  } catch (e) {
    if (e instanceof Error && e.name === "RepoResolutionError" &&
        (e as Error & { code: string }).code !== "supabase_read_failed") return null;
    console.warn(`[emitDecision] engineer repo read threw (fail-open): ${(e as Error).message}`);
    return {};
  }
}

export async function resolveNamedEngineerRepo(tenant_id: string): Promise<{ repo: string; site_id?: string } | null> {
  const target = await resolveEngineerDispatchRepo(tenant_id);
  return target?.repo ? { repo: target.repo, ...(target.site_id ? { site_id: target.site_id } : {}) } : null;
}
