// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const OLDER = "Praxis-build/paws-suds-693dfbdb-aaaaaa";
const NEWER = "Praxis-build/still-water-yoga-693dfbdb-bbbbbb";
const OLD_RUN = "11111111-0000-4000-8000-00000000000a";
const NEW_RUN = "22222222-0000-4000-8000-00000000000b";

const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  setDefault: vi.fn(),
  sessionsFail: false,
  sessionsGate: null as Promise<void> | null,
}));

vi.mock("@/lib/workspace/useGithubRepos", () => ({
  useGithubRepos: () => ({
    state: { status: "ok", connected: true, repos: [NEWER], default: NEWER, hiddenByScope: 0 },
    pending: false,
    setDefault: h.setDefault,
  }),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (url: string) => {
    if (url === "/api/workspace/autopilot/build-sessions") {
      if (h.sessionsGate) await h.sessionsGate;
      if (h.sessionsFail) return { ok: false, status: 500, json: async () => ({}) };
    }
    return {
    ok: true,
    json: async () =>
      url === "/api/workspace/autopilot/build-sessions"
        ? {
            current_session_id: NEW_RUN,
            flags: h.flags,
            sessions: [
              { id: NEW_RUN, title: "b", request: "b", state: "ready", run_status: "done", created_at: "", last_activity_at: "", refine_count: 0, is_current: true, site: { hostname: "still-water-yoga-693dfbdb-bbbbbb.zaviagent.com", live_url: null, status: "live", name: "Still Water Yoga", repo: NEWER } },
              { id: OLD_RUN, title: "a", request: "a", state: "ready", run_status: "done", created_at: "", last_activity_at: "", refine_count: 0, is_current: true, site: { hostname: "paws-suds-693dfbdb-aaaaaa.zaviagent.com", live_url: null, status: "live", name: "Paws & Suds", repo: OLDER } },
            ],
          }
        : {},
    };
  }),
}));

import { BuildComposerMenu } from "./BuildComposerMenu";
import { __resetBuildSessionsForTest } from "@/lib/workspace/useBuildSessions";

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

async function openMenu(sessionId: string | null) {
  render(
    <BuildComposerMenu selectedChannels={[]} onToggleChannel={() => {}} role="owner" onManageConnectors={() => {}} sessionId={sessionId} />,
  );
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Add to this build" }));
  await flush();
}

beforeEach(() => {
  __resetBuildSessionsForTest();
  h.flags = { site_names: true, site_repo_chip: true, site_list_details: true };
  h.setDefault.mockReset();
  h.sessionsFail = false;
  h.sessionsGate = null;
});

afterEach(() => cleanup());

describe("DEL-1323 B6: the build page's own composer menu shows that build's repo", () => {
  it("an older site's build page shows the older site's repo, not the workspace default, and offers no switch that would move the workspace repo", async () => {
    await openMenu(OLD_RUN);
    const row = document.querySelector("[data-site-repo-chip]");
    expect(row?.getAttribute("data-site-repo-chip")).toBe(OLDER);
    expect(screen.getByText(OLDER)).toBeTruthy();
    expect(screen.queryByText(NEWER)).toBeNull();
    fireEvent.click(row as Element);
    await flush();
    expect(screen.queryByText("Agents work in this repo")).toBeNull();
    expect(h.setDefault).not.toHaveBeenCalled();
  });

  it("the newer site's page shows the newer repo", async () => {
    await openMenu(NEW_RUN);
    expect(document.querySelector("[data-site-repo-chip]")?.getAttribute("data-site-repo-chip")).toBe(NEWER);
  });

  it("with the key off the row is the workspace repo picker, as before", async () => {
    h.flags = { site_names: true, site_repo_chip: false, site_list_details: true };
    await openMenu(OLD_RUN);
    expect(document.querySelector("[data-site-repo-chip]")).toBeNull();
    expect(screen.getByText(NEWER)).toBeTruthy();
  });

  it("when build-sessions fails, the GitHub row is the workspace repo picker, not a disabled 'Each site has its own repo'", async () => {
    h.sessionsFail = true;
    await openMenu(OLD_RUN);
    expect(document.querySelector("[data-site-repo-chip]")).toBeNull();
    expect(screen.queryByText("Each site has its own repo")).toBeNull();
    expect(screen.getByText(NEWER)).toBeTruthy();
    fireEvent.click(screen.getByText("GitHub repo"));
    await flush();
    expect(screen.queryByText("Each site has its own repo")).toBeNull();
  });

  it("while build-sessions is in flight the row holds the site placeholder", async () => {
    h.sessionsGate = new Promise<void>(() => {});
    await openMenu(OLD_RUN);
    expect(document.querySelector("[data-site-repo-chip]")).not.toBeNull();
    expect(screen.getByText("Each site has its own repo")).toBeTruthy();
  });
});
