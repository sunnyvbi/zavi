import { describe, it, expect, vi } from "vitest";
import { BUILD_CHECKS_FAILED, BUILD_PUBLISH_FAILED } from "@zavi/shared";
import type { SiteRow } from "../contract";
import { customDomainsFor, sitePublishNeedsState, sitePublishStates, type SitePublishReads } from "../site-publish-state";

const GATE_ERROR =
  "gate: the home page shows no photo, but the site has generated photos in public/images/ (see public/images/zavi-images.json)";

function site(over: Partial<SiteRow> = {}): SiteRow {
  return {
    id: "s1",
    tenant_id: "t1",
    root_conductor_run_id: "root1",
    started_by_user_id: null,
    owner_email: null,
    label: "acme",
    hostname: "acme-1.zaviagent.com",
    github_full_name: "build-org/acme",
    supabase_project_ref: null,
    supabase_url: null,
    status: "live",
    live_url: "https://acme-1.zaviagent.com",
    desired_sha: "e0027618aaaa",
    live_sha: "00acd47bbbbb",
    live_deploy_id: null,
    last_visit_at: null,
    last_edit_at: null,
    paused_at: null,
    last_error: GATE_ERROR,
    publish_run_id: "pub1",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-22T00:00:00Z",
    ...over,
  };
}

function reads(over: Partial<SitePublishReads> = {}): SitePublishReads {
  return {
    publishRuns: vi.fn(async () => [
      {
        id: "pub1",
        status: "failed",
        created_at: "2026-10-22T04:35:15Z",
        failure_class: "deploy_failed",
        failure_reason: "The site's smoke check failed: " + GATE_ERROR,
      },
    ]),
    previews: vi.fn(async () => [{ repo_full_name: "build-org/acme", preview_url: "https://preview.example/acme", preview_status: "live" }]),
    probe: vi.fn(async () => "ok"),
    ...over,
  };
}

describe("sitePublishStates", () => {
  it("a failed publish: pending, both versions, the founder's line (never the raw error), the preview", async () => {
    const st = (await sitePublishStates("t1", [site()], reads())).get("s1")!;
    expect(st.pending).toBe(true);
    expect(st.publish_status).toBe("failed");
    expect(st.live_version).toBe("00acd47");
    expect(st.latest_version).toBe("e002761");
    expect(st.last_problem).toBe(BUILD_CHECKS_FAILED);
    expect(st.previous_version_still_live).toBe(true);
    expect(JSON.stringify(st)).not.toMatch(/public\/images|zavi-images|smoke check|gate:/);
    expect(st.preview_url).toBe("https://preview.example/acme");
    expect(st.preview_checked).toBe(true);
    expect(st.open_in_zavi).toMatch(/\/workspace\?tab=website&company=t1$/);
  });

  it("a stored 'live' preview that does not answer is not offered; the Website tab still is", async () => {
    const st = (await sitePublishStates("t1", [site()], reads({ probe: async () => "dead" }))).get("s1")!;
    expect(st.preview_url).toBeNull();
    expect(st.preview_checked).toBe(true);
    expect(st.open_in_zavi).toMatch(/tab=website/);
  });

  it("a publish still running has no problem line", async () => {
    const st = (
      await sitePublishStates(
        "t1",
        [site({ last_error: null })],
        reads({ publishRuns: async () => [{ id: "pub1", status: "active", created_at: null, failure_class: null, failure_reason: null }] }),
      )
    ).get("s1")!;
    expect(st).toMatchObject({ pending: true, publish_status: "publishing", last_problem: null });
  });

  it("no publish run to read: the site's own error, in the founder's words", async () => {
    const st = (await sitePublishStates("t1", [site({ publish_run_id: null })], reads())).get("s1")!;
    expect(st.last_problem).toBe(BUILD_CHECKS_FAILED);
    expect(JSON.stringify(st)).not.toMatch(/public\/images|gate:/);
  });

  it("a site with nothing waiting and no error is left out, and nothing is read", async () => {
    const r = reads();
    const clean = site({ desired_sha: "abc", live_sha: "abc", last_error: null });
    expect(sitePublishNeedsState(clean)).toBe(false);
    expect((await sitePublishStates("t1", [clean], r)).size).toBe(0);
    expect(r.publishRuns).not.toHaveBeenCalled();
    expect(r.previews).not.toHaveBeenCalled();
  });

  it("each read fails on its own: unknown, never 'nothing is wrong'", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const noPreview = (await sitePublishStates("t1", [site()], reads({ previews: async () => { throw new Error("boom"); } }))).get("s1")!;
    expect(noPreview.preview_checked).toBe(false);
    expect(noPreview.last_problem).toBe(BUILD_CHECKS_FAILED);
    const noRuns = (await sitePublishStates("t1", [site()], reads({ publishRuns: async () => { throw new Error("boom"); } }))).get("s1")!;
    expect(noRuns.publish_status).toBeNull();
    expect(noRuns.last_problem).toBeNull();
    expect(noRuns.preview_url).toBe("https://preview.example/acme");
    warn.mockRestore();
  });

  it("a publish that stopped for another reason says it did not go online", async () => {
    const st = (
      await sitePublishStates(
        "t1",
        [site({ last_error: null })],
        reads({ publishRuns: async () => [{ id: "pub1", status: "failed", created_at: null, failure_class: "deploy_failed", failure_reason: "cloudflare upload 502" }] }),
      )
    ).get("s1")!;
    expect(st.last_problem).toBe(BUILD_PUBLISH_FAILED);
    expect(JSON.stringify(st)).not.toMatch(/cloudflare|502/);
  });

  it("custom domains: the original app has them (owner or admin); a site does not yet", () => {
    const both = customDomainsFor({ workspace_app: true, site: true });
    expect(both.workspace_app).toMatchObject({ available: true, api: "/api/website/custom-domains" });
    expect(both.workspace_app!.where).toMatch(/owner or admin/);
    expect(both.site).toMatchObject({ available: false });
    expect(customDomainsFor({ workspace_app: false, site: true })).not.toHaveProperty("workspace_app");
  });
});
