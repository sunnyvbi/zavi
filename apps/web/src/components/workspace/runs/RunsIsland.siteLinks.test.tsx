// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { RunsIsland, runCardLinks } from "./RunsIsland";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

const target = { repo_url: "https://github.com/zavi-build/workspace-app", live_url: "https://workspace-app.onrender.com" };

function run(id: string, objective: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    objective,
    status: "done",
    spend_usd: 1,
    max_usd: 10,
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-01T10:05:00Z",
    node_summary: [],
    stalled: false,
    ...extra,
  };
}

const siteA = { id: "site-a", hostname: "bakery-a1b2.zaviagent.com", session_id: "11111111-1111-4111-8111-111111111111", repo_url: "https://github.com/zavi-build/bakery", live_url: "https://bakery-a1b2.zaviagent.com" };
const siteB = { id: "site-b", hostname: "gym-c3d4.zaviagent.com", session_id: "22222222-2222-4222-8222-222222222222", repo_url: "https://github.com/zavi-build/gym", live_url: null };

describe("runCardLinks", () => {
  it("keeps the workspace target for an old-flow run", () => {
    expect(runCardLinks({ site_id: null }, target)).toEqual({ build_href: null, ...target });
    expect(runCardLinks({}, target)).toEqual({ build_href: null, ...target });
  });

  it("never falls back to the workspace target for a site run whose site could not be read", () => {
    expect(runCardLinks({ site_id: "site-x", site: null }, target)).toEqual({ build_href: null, repo_url: null, live_url: null });
  });
});

describe("RunsIsland site runs", () => {
  it("links each of two sites' runs to its own session, repo and address", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        runs: [
          run("r1", "Bakery site", { site_id: "site-a", site: siteA }),
          run("r2", "Gym site", { site_id: "site-b", site: siteB }),
          run("r3", "Workspace app", { site_id: null, site: null }),
        ],
        target,
      }),
    });
    render(<RunsIsland />);
    const bakery = (await screen.findByText("Bakery site")).closest("li")!;
    const gym = screen.getByText("Gym site").closest("li")!;
    const app = screen.getByText("Workspace app").closest("li")!;

    const hrefs = (el: HTMLElement) => within(el).queryAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs(bakery)).toEqual([`/workspace?tab=build&build=${siteA.session_id}`, siteA.repo_url, siteA.live_url]);
    expect(hrefs(gym)).toEqual([`/workspace?tab=build&build=${siteB.session_id}`, siteB.repo_url]);
    expect(hrefs(app)).toEqual([target.repo_url, target.live_url]);
  });
});
