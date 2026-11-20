// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, within } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ role: "owner", openTab: vi.fn() }),
}));

import { WebsiteConsole, __resetAppCatalogInflight } from "./WebsiteConsole";
import { __resetBuildSessionsForTest } from "@/lib/workspace/useBuildSessions";

const PAWS = "aaaaaaaa-1111-4000-8000-00000000000a";
const YOGA = "bbbbbbbb-1111-4000-8000-00000000000b";
const PROMPT = "Booking website for my dog grooming s…";

const session = (id: string, name: string, host: string) => ({
  id,
  title: "Booking website for my dog grooming salon",
  request: "Booking website for my dog grooming salon in Austin",
  state: "ready",
  run_status: "done",
  created_at: "2026-10-05T00:00:00Z",
  last_activity_at: "2026-10-05T00:00:00Z",
  refine_count: 0,
  is_current: true,
  site: { hostname: host, live_url: `https://${host}`, status: "live", name },
});

let answerSessions: () => void = () => {};

function wire(opts: { siteNames?: boolean; sessionsLate?: boolean } = {}) {
  apiFetch.mockImplementation(async (url: string) => {
    if (url === "/api/workspace/autopilot/build-sessions") {
      const body = {
        sessions: [session(YOGA, "Sun Salute", "sun-salute.zavi.site"), session(PAWS, "Paws & Suds", "paws-suds.zavi.site")],
        current_session_id: PAWS,
        flags: { site_names: opts.siteNames ?? true },
      };
      const res = { ok: true, json: async () => body };
      if (!opts.sessionsLate) return res;
      return new Promise((resolve) => {
        answerSessions = () => resolve(res);
      });
    }
    if (url.startsWith("/api/website/overview")) {
      return {
        ok: true,
        json: async () => ({
          app: { name: PROMPT, description: "Booking website for my dog grooming salon in Austin", created_at: null, deployed_url: "https://paws-suds.zavi.site", build_status: "done" },
          visibility: null,
          badge_hidden: null,
          site: { id: "site-paws", hostname: "paws-suds.zavi.site", status: "live" },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

beforeEach(() => {
  apiFetch.mockReset();
  __resetAppCatalogInflight();
  __resetBuildSessionsForTest();
});
afterEach(() => cleanup());

describe("l4.3: App settings names a site the way Your sites does", () => {
  it("shows the site's name and initial, not the build prompt", async () => {
    wire();
    render(<WebsiteConsole buildSessionId={PAWS} />);
    expect(await screen.findByRole("heading", { level: 2, name: "Paws & Suds" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: PROMPT })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Sun Salute" })).toBeNull();
    expect(screen.getByTestId("app-initial-tile").textContent).toBe("P");
  });

  it("swaps the prompt for the name when the sites list lands after the overview", async () => {
    wire({ sessionsLate: true });
    render(<WebsiteConsole buildSessionId={PAWS} />);
    expect(await screen.findByRole("heading", { level: 2, name: PROMPT })).toBeTruthy();
    await act(async () => {
      answerSessions();
    });
    const heading = await screen.findByRole("heading", { level: 2, name: "Paws & Suds" });
    expect(within(heading.parentElement!.parentElement!.parentElement!).getByTestId("app-initial-tile").textContent).toBe("P");
    expect(screen.queryByRole("heading", { name: PROMPT })).toBeNull();
  });

  it("keeps the server's name while site names are switched off, like the Your sites card", async () => {
    wire({ siteNames: false });
    render(<WebsiteConsole buildSessionId={PAWS} />);
    expect(await screen.findByRole("heading", { level: 2, name: PROMPT })).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByRole("heading", { name: "Paws & Suds" })).toBeNull();
  });
});
