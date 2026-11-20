import { describe, expect, it, vi } from "vitest";
import type { SiteRow } from "../contract";
import {
  SITE_PREVIEW_RESTART_WINDOW_MS,
  activeSiteRunExists,
  restartSitePreview,
  sitePreviewState,
} from "../site-preview-restart";

const TENANT = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

function site(over: Partial<SiteRow> = {}): SiteRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    tenant_id: TENANT,
    root_conductor_run_id: RUN,
    started_by_user_id: null,
    owner_email: null,
    label: "rental",
    hostname: "rental.zaviagent.com",
    github_full_name: "Zavi-Latest-Build/rental-4b5ad1a6-a93554",
    supabase_project_ref: null,
    supabase_url: null,
    status: "building",
    live_url: null,
    desired_sha: null,
    live_sha: null,
    live_deploy_id: null,
    last_visit_at: null,
    last_edit_at: null,
    paused_at: null,
    last_error: null,
    ...over,
  } as SiteRow;
}

describe("sitePreviewState", () => {
  it("calls a finished, unpublished build with no preview stopped, and starting while the site's restart lease is held", () => {
    const s = site();
    expect(sitePreviewState({ site: s, run_status: "done", preview_kind: "none" })).toBe("stopped");
    expect(sitePreviewState({ site: s, run_status: "done", preview_kind: "none", restarting: true })).toBe("starting");
  });

  it("a served preview is never a restart state", () => {
    expect(sitePreviewState({ site: site(), run_status: "done", preview_kind: "instant", restarting: true })).toBeNull();
  });

  it("says starting while the sandbox boots, a wake was just sent, or an edit on the site is running", () => {
    const s = site();
    const base = { site: s, run_status: "done", preview_kind: "none" as const };
    expect(sitePreviewState({ ...base, sandbox_status: "starting" })).toBe("starting");
    expect(sitePreviewState({ ...base, waking: true })).toBe("starting");
    expect(sitePreviewState({ ...base, site_run_active: true })).toBe("starting");
    expect(sitePreviewState({ ...base, sandbox_status: "dead", waking: false, site_run_active: false })).toBe("stopped");
    expect(sitePreviewState({ ...base, sandbox_status: "live" })).toBe("stopped");
  });

  it("a sandbox stuck at starting (a boot that never served) falls back to stopped after the restart window", () => {
    const base = { site: site(), run_status: "done", preview_kind: "none" as const, sandbox_status: "starting" };
    const t0 = Date.parse("2026-10-02T10:00:00.000Z");
    expect(sitePreviewState({ ...base, sandbox_updated_at: "2026-10-02T10:00:00.000Z", nowMs: t0 + SITE_PREVIEW_RESTART_WINDOW_MS - 1 })).toBe("starting");
    expect(sitePreviewState({ ...base, sandbox_updated_at: "2026-10-02T10:00:00.000Z", nowMs: t0 + SITE_PREVIEW_RESTART_WINDOW_MS })).toBe("stopped");
  });

  it("says nothing for a running build, a published site, or a site with no repo", () => {
    expect(sitePreviewState({ site: site(), run_status: "active", preview_kind: "none" })).toBeNull();
    expect(
      sitePreviewState({ site: site({ status: "live", live_deploy_id: "dep_1" }), run_status: "done", preview_kind: "none" }),
    ).toBeNull();
    expect(
      sitePreviewState({ site: site({ live_deploy_id: "dep_1" }), run_status: "done", preview_kind: "none" }),
    ).toBeNull();
    expect(sitePreviewState({ site: site({ github_full_name: null }), run_status: "done", preview_kind: "none" })).toBeNull();
  });
});

describe("restartSitePreview", () => {
  it("re-seeds a sandbox and boots the preview on the new box for this site's own repo", async () => {
    const s = site();
    const reseed = vi.fn(async () => "e2b_new");
    const ready = vi.fn(async () => undefined);
    await restartSitePreview({ tenant_id: TENANT, run_id: RUN, site: s }, { reseed, ready });
    expect(reseed).toHaveBeenCalledWith(TENANT, s);
    await restartSitePreview({ tenant_id: TENANT, run_id: RUN, site: s, sha: "a".repeat(40), awaitReadiness: true }, { reseed, ready });
    expect(reseed).toHaveBeenLastCalledWith(TENANT, s, "a".repeat(40));
    expect(ready).toHaveBeenLastCalledWith(expect.objectContaining({ e2b_sandbox_id: "e2b_new" }), { awaitReadiness: true });
    expect(ready).toHaveBeenCalledWith({
      tenant_id: TENANT,
      run_id: RUN,
      site_id: s.id,
      repo_full_name: "Zavi-Latest-Build/rental-4b5ad1a6-a93554",
      e2b_sandbox_id: "e2b_new",
    });
  });

  it("releases the lease when the re-seed fails, so the pane offers Restart again instead of spinning", async () => {
    const release = vi.fn(async () => undefined);
    const ready = vi.fn(async () => undefined);
    await expect(
      restartSitePreview({ tenant_id: TENANT, run_id: RUN, site: site(), release }, { reseed: async () => Promise.reject(new Error("e2b capacity")), ready }),
    ).rejects.toThrow("e2b capacity");
    expect(ready).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the lease when the preview boot throws or reports failure", async () => {
    const r1 = vi.fn(async () => undefined);
    await expect(
      restartSitePreview(
        { tenant_id: TENANT, run_id: RUN, site: site(), release: r1 },
        { reseed: async () => "e2b_new", ready: async () => Promise.reject(new Error("preview could not be stopped")) },
      ),
    ).rejects.toThrow("preview could not be stopped");
    expect(r1).toHaveBeenCalledTimes(1);
    const r2 = vi.fn(async () => undefined);
    await restartSitePreview(
      { tenant_id: TENANT, run_id: RUN, site: site(), release: r2 },
      { reseed: async () => "e2b_new", ready: async () => "preview_failed" as const },
    );
    expect(r2).toHaveBeenCalledTimes(1);
  });

  it("keeps the lease while a booted preview is still coming up", async () => {
    const release = vi.fn(async () => undefined);
    await restartSitePreview(
      { tenant_id: TENANT, run_id: RUN, site: site(), release },
      { reseed: async () => "e2b_new", ready: async () => "preview_starting" as const },
    );
    expect(release).not.toHaveBeenCalled();
  });

  it("never re-seeds a site from another workspace", async () => {
    const reseed = vi.fn(async () => "e2b_new");
    await expect(
      restartSitePreview(
        { tenant_id: TENANT, run_id: RUN, site: site({ tenant_id: "99999999-9999-4999-8999-999999999999" }) },
        { reseed, ready: async () => undefined },
      ),
    ).rejects.toThrow();
    expect(reseed).not.toHaveBeenCalled();
  });
});

describe("activeSiteRunExists", () => {
  type Row = { id: string; tenant_id: string; kind: string; status: string; goal_graph: Array<{ payload: Record<string, unknown> }> };
  function client(rows: Row[], fail = false) {
    return {
      from: () => {
        const f: Array<(r: Row) => boolean> = [];
        const q = {
          select: () => q,
          eq: (k: string, v: unknown) => {
            f.push((r) =>
              k === "goal_graph->0->payload->>site_id" ? r.goal_graph[0]?.payload?.site_id === v : (r as Record<string, unknown>)[k] === v,
            );
            return q;
          },
          in: (k: string, vs: unknown[]) => {
            f.push((r) => vs.includes((r as Record<string, unknown>)[k]));
            return q;
          },
          limit: async () => (fail ? { data: null, error: { message: "down" } } : { data: rows.filter((r) => f.every((p) => p(r))), error: null }),
        };
        return q;
      },
    } as never;
  }
  const S = "33333333-3333-4333-8333-333333333333";
  const OTHER = "44444444-4444-4444-8444-444444444444";
  const row = (status: string, site_id: string, tenant_id = TENANT): Row => ({
    id: `${status}-${site_id}`,
    tenant_id,
    kind: "build_app",
    status,
    goal_graph: [{ payload: { stage: "build", refine_mode: true, site_id } }],
  });

  it("sees an in-flight run on this site, including one paused on a wake", async () => {
    for (const st of ["provisioning", "active", "paused"]) {
      expect(await activeSiteRunExists(client([row(st, S)]), TENANT, S)).toBe(true);
    }
  });

  it("ignores finished runs, other sites' runs and other tenants' runs", async () => {
    const rows = [row("done", S), row("failed", S), row("halted", S), row("active", OTHER), row("active", S, "99999999-9999-4999-8999-999999999999")];
    expect(await activeSiteRunExists(client(rows), TENANT, S)).toBe(false);
  });

  it("an unreadable answer counts as busy", async () => {
    expect(await activeSiteRunExists(client([], true), TENANT, S)).toBe(true);
  });
});
