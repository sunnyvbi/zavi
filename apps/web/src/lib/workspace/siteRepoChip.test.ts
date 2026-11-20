import { describe, expect, it } from "vitest";
import type { BuildSessionMeta } from "./buildHistory";
import { repoHintFor, resolveRepoChip, type RepoChipSessions } from "./siteRepoChip";

function session(id: string, repo?: string): BuildSessionMeta {
  return {
    id,
    title: id,
    request: "",
    state: "ready",
    run_status: "completed",
    created_at: "2026-10-01T00:00:00Z",
    last_activity_at: "2026-10-01T00:00:00Z",
    refine_count: 0,
    is_current: false,
    ...(repo ? { site: { hostname: `${id}.zaviagent.com`, live_url: null, status: "live", repo } } : {}),
  } as BuildSessionMeta;
}

const ON = { siteNames: true, siteRepoChip: true, siteListDetails: true };
const oneSiteA: RepoChipSessions = { loaded: true, sessions: [session("a", "praxis-built/site-a")], flags: ON };

describe("resolveRepoChip in build scope never borrows another site's repo", () => {
  it("a just-started site B that the sessions list has not caught up with shows no repo and sends no repo_hint", () => {
    const chip = resolveRepoChip({ kind: "build", sessionId: "b" }, oneSiteA, "praxis-built/site-a");
    expect(chip).toEqual({ repo: null, site: true });
    expect(repoHintFor(chip)).toBeUndefined();
  });

  it("the new-build composer (no session yet) in a workspace with a site shows no repo", () => {
    const chip = resolveRepoChip({ kind: "build", sessionId: null }, oneSiteA, "praxis-built/site-a");
    expect(chip).toEqual({ repo: null, site: true });
    expect(repoHintFor(chip)).toBeUndefined();
  });

  it("the open site's own build page still uses that site's repo", () => {
    const chip = resolveRepoChip({ kind: "build", sessionId: "a" }, oneSiteA, "praxis-built/other");
    expect(chip).toEqual({ repo: "praxis-built/site-a", site: true });
    expect(repoHintFor(chip)).toBe("praxis-built/site-a");
  });

  it("a tenant with its own GitHub repo keeps it on the new-build composer, never the one site's repo", () => {
    const chip = resolveRepoChip({ kind: "build", sessionId: null }, oneSiteA, "acme/app", true);
    expect(chip).toEqual({ repo: "acme/app", site: false });
    expect(repoHintFor(chip)).toBeUndefined();
  });

  it("a workspace with no sites yet keeps the workspace default on the new-build composer", () => {
    expect(resolveRepoChip({ kind: "build", sessionId: null }, { loaded: true, sessions: [], flags: ON }, "praxis-built/legacy")).toEqual({
      repo: "praxis-built/legacy",
      site: false,
    });
  });

  it("Home with one site is unchanged: the chip is that site's repo", () => {
    expect(resolveRepoChip({ kind: "home" }, oneSiteA, null)).toEqual({ repo: "praxis-built/site-a", site: true });
  });
});
