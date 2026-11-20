import type { SiteRow } from "@/services/sites/contract";

export const SITE_ROOT_RUN = "cr_site_root";

export function testSite(over: Partial<SiteRow> = {}): SiteRow {
  return {
    id: "site_1",
    tenant_id: "t1",
    root_conductor_run_id: SITE_ROOT_RUN,
    started_by_user_id: null,
    owner_email: null,
    label: "acme",
    hostname: "acme.zaviagent.com",
    github_full_name: "praxis-built/acme",
    supabase_project_ref: null,
    supabase_url: null,
    status: "live",
    live_url: "https://acme.zaviagent.com",
    desired_sha: null,
    live_sha: null,
    live_deploy_id: null,
    last_visit_at: null,
    last_edit_at: null,
    paused_at: null,
    last_error: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over,
  } as SiteRow;
}
