import { describe, expect, it } from "vitest";
import { buildSessionTitle, mergeHistory, siteBadge, siteHref, siteName } from "./buildHistory";

describe("new-flow site badge", () => {
  it("maps site statuses to Live / Building / Paused / Failed", () => {
    const at = (status: string) => siteBadge({ hostname: "a.zaviagent.com", live_url: null, status })?.label ?? null;
    expect(at("live")).toBe("Live");
    expect(at("building")).toBe("Building");
    expect(at("publishing")).toBe("Building");
    expect(at("provisioning")).toBe("Building");
    expect(at("paused")).toBe("Paused");
    expect(at("waking")).toBe("Paused");
    expect(at("failed")).toBe("Failed");
    expect(at("fell_back_old")).toBeNull();
    expect(siteBadge(undefined)).toBeNull();
  });

  it("never says Building next to a stopped run (QA B12: 'Stopped' + 'Building')", () => {
    const site = (status: string) => ({ hostname: "a.zaviagent.com", live_url: null, status });
    expect(siteBadge(site("building"), "failed")).toBeNull();
    expect(siteBadge(site("publishing"), "publish_failed")).toBeNull();
    expect(siteBadge(site("building"), "building")?.label).toBe("Building");
    expect(siteBadge(site("publishing"), "publishing")?.label).toBe("Building");
    expect(siteBadge(site("live"), "publish_failed")?.label).toBe("Live");
    expect(siteBadge(site("failed"), "failed")?.label).toBe("Failed");
  });

  it("a built site that was never published reads Not published, never Live or Building, whatever the setting says", () => {
    const site = (status: string, live_url: string | null = null) => ({ hostname: "a.zaviagent.com", live_url, status });
    expect(siteBadge(site("building"), "ready")).toEqual({ label: "Not published", tone: "muted" });
    expect(siteBadge(site("provisioning"), "ready")?.label).toBe("Not published");
    expect(siteHref(site("building"))).toBeNull();
  });

  it("a site that was published, is still building, or stopped keeps today's badge", () => {
    const site = (status: string, live_url: string | null = null) => ({ hostname: "a.zaviagent.com", live_url, status });
    expect(siteBadge(site("live", "https://a.zaviagent.com"), "ready")?.label).toBe("Live");
    expect(siteBadge(site("live"), "ready")?.label).toBe("Live");
    expect(siteBadge(site("paused"), "ready")?.label).toBe("Paused");
    expect(siteBadge(site("failed"), "ready")?.label).toBe("Failed");
    expect(siteBadge(site("publishing"), "ready")).toBeNull();
    expect(siteBadge(site("building"), "building")?.label).toBe("Building");
    expect(siteBadge(site("building"), "failed")).toBeNull();
    expect(siteBadge(site("building"))?.label).toBe("Building");
  });

  it("links only to an https address", () => {
    expect(siteHref({ hostname: "a", live_url: "https://a.zaviagent.com", status: "live" })).toBe("https://a.zaviagent.com");
    expect(siteHref({ hostname: "a", live_url: "javascript:alert(1)", status: "live" })).toBeNull();
    expect(siteHref({ hostname: "a", live_url: null, status: "building" })).toBeNull();
  });
});

describe("DEL-1323 B34/B36: Recent and Your sites name each site", () => {
  const thread = {
    id: "th1",
    agent_slug: "operator",
    title: "Hello",
    last_message: null,
    last_message_at: "2026-10-01T00:00:00Z",
    created_at: "2026-10-01T00:00:00Z",
    run_status: null,
    presentation_status: null,
    unread: false,
  } as never;
  const site = (name: string | null, hostname: string) => ({
    hostname,
    live_url: null,
    status: "live",
    name,
    repo: `Praxis-build/${hostname.split(".")[0]}`,
  });
  const base = { state: "ready", run_status: "done", refine_count: 0, is_current: true };
  const sessions = [
    {
      ...base,
      id: "a",
      title: "Build product: Apna Tutor — a site",
      request: "a site",
      created_at: "2026-10-01T01:00:00Z",
      last_activity_at: "2026-10-01T01:00:00Z",
      site: site("Paws & Suds", "paws-suds-693dfbdb-aaaaaa.zaviagent.com"),
    },
    {
      ...base,
      id: "b",
      title: "Build product: Apna Tutor — yoga",
      request: "yoga",
      state: "building",
      run_status: "active",
      created_at: "2026-10-01T02:00:00Z",
      last_activity_at: "2026-10-01T02:00:00Z",
      site: site(null, "still-water-yoga-693dfbdb-bbbbbb.zaviagent.com"),
    },
    {
      ...base,
      id: "c",
      title: "Old app",
      request: "old",
      created_at: "2026-09-01T00:00:00Z",
      last_activity_at: "2026-09-01T00:00:00Z",
    },
  ] as never[];
  const now = Date.parse("2026-10-01T03:00:00Z");

  it("with site names on, a site row is titled with its own name and carries its site; others keep their title", () => {
    const items = mergeHistory([thread], sessions, { now, siteNames: true });
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId.a.title).toBe("Paws & Suds");
    expect(byId.b.title).toBe("Build product: Apna Tutor — yoga");
    expect(byId.c.title).toBe("Old app");
    expect(byId.a.kind === "build" ? byId.a.site?.hostname : null).toBe("paws-suds-693dfbdb-aaaaaa.zaviagent.com");
    expect(byId.c.kind === "build" ? byId.c.site : "x").toBeUndefined();
  });

  it("with site names off the titles stay the build titles", () => {
    const items = mergeHistory([thread], sessions, { now });
    expect(items.find((i) => i.id === "a")?.title).toBe("Build product: Apna Tutor — a site");
  });

  it("buildSessionTitle and siteName ignore a blank name", () => {
    expect(siteName({ hostname: "x", live_url: null, status: "live", name: "   " })).toBeNull();
    expect(buildSessionTitle(sessions[0] as never, true)).toBe("Paws & Suds");
    expect(buildSessionTitle(sessions[0] as never, false)).toBe("Build product: Apna Tutor — a site");
  });
});
