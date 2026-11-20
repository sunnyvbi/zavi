// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const OLDER = "Praxis-build/paws-suds-693dfbdb-aaaaaa";
const NEWER = "Praxis-build/still-water-yoga-693dfbdb-bbbbbb";
const OLD_RUN = "11111111-0000-4000-8000-00000000000a";
const NEW_RUN = "22222222-0000-4000-8000-00000000000b";

const h = vi.hoisted(() => ({
  send: vi.fn(),
  sessions: [] as unknown[],
  flags: {} as Record<string, boolean> | undefined,
  sessionsGate: null as Promise<void> | null,
  repoDefault: null as string | null,
  repoLogin: "Praxis-build" as string | null,
  repoList: [] as string[],
  repoLoading: false,
}));

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("./WorkspaceShell", () => {
  const noop = () => {};
  return {
    useWorkspace: () => ({
      setTabDirty: noop,
      setTabThreadId: noop,
      role: "owner",
      composerSeeds: {},
      consumeComposerSeed: noop,
      closeTab: noop,
      openTab: noop,
    }),
  };
});
vi.mock("@/lib/workspace/useAgentRun", () => ({
  useAgentRun: () => ({ inflight: false, error: null, send: h.send }),
}));
vi.mock("@/lib/workspace/tenantCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/tenantCommands")>()),
  useTenantCommands: () => ({ commands: [], loaded: true, error: null }),
}));
vi.mock("@/lib/workspace/useFeedback", () => ({ submitFeedback: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/workspace/useGithubRepos", () => {
  const state = () =>
    h.repoLoading
      ? { status: "loading" }
      : {
          status: "ok",
          connected: true,
          repos: h.repoList,
          default: h.repoDefault,
          hiddenByScope: 0,
          accountLogin: h.repoLogin,
        };
  return {
    useGithubRepos: () => ({ state: state(), pending: false, setDefault: vi.fn() }),
    readGithubRepos: () => state(),
  };
});
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (url: string) => {
    if (url === "/api/workspace/autopilot/build-sessions") {
      if (h.sessionsGate) await h.sessionsGate;
      return {
        ok: true,
        json: async () => ({ sessions: h.sessions, current_session_id: NEW_RUN, flags: h.flags }),
      };
    }
    return { ok: true, json: async () => ({}) };
  }),
}));

import { Composer } from "./Composer";
import { __resetBuildSessionsForTest } from "@/lib/workspace/useBuildSessions";
import type { RepoChipScope } from "@/lib/workspace/siteRepoChip";

Element.prototype.scrollIntoView = () => {};

function session(id: string, repo: string, hostname: string, name: string) {
  return {
    id,
    title: "Build product",
    request: "a site",
    state: "ready",
    run_status: "done",
    created_at: "2026-10-01T00:00:00Z",
    last_activity_at: "2026-10-01T00:00:00Z",
    refine_count: 0,
    is_current: true,
    site: { hostname, live_url: `https://${hostname}`, status: "live", name, repo },
  };
}

const TWO_SITES = [
  session(NEW_RUN, NEWER, "still-water-yoga-693dfbdb-bbbbbb.zaviagent.com", "Still Water Yoga"),
  session(OLD_RUN, OLDER, "paws-suds-693dfbdb-aaaaaa.zaviagent.com", "Paws & Suds"),
];
const ON = { site_names: true, site_repo_chip: true, site_list_details: true };

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

function mount(scope?: RepoChipScope, agentSlug = "operator") {
  return render(
    <Composer
      agentSlug={agentSlug}
      tabId="t"
      threadId={null}
      onOptimistic={() => "o"}
      onSent={() => {}}
      repoChipScope={scope}
    />,
  );
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;

async function type(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  await flush();
  fireEvent.keyDown(box(), { key: "Enter" });
  await flush();
}

function chipRepos(): string[] {
  return [...document.querySelectorAll("[data-site-repo-chip]")].map((el) => el.getAttribute("data-site-repo-chip") ?? "");
}

beforeEach(() => {
  __resetBuildSessionsForTest();
  h.send.mockReset();
  h.send.mockResolvedValue({ kind: "queued", thread_id: "th", user_message_id: "m", run_id: "r" });
  h.sessions = TWO_SITES;
  h.flags = ON;
  h.sessionsGate = null;
  h.repoDefault = NEWER;
  h.repoLogin = "Praxis-build";
  h.repoList = [NEWER];
  h.repoLoading = false;
});

afterEach(() => cleanup());

describe("DEL-1323 B6: the engineer works in the open site's repo, and an owner never sees a Zavi-made repo name", () => {
  it("on an OLDER site's build page (two sites, workspace default = the newer one) the chip and the engineer's repo_hint are the older site's repo", async () => {
    mount({ kind: "build", sessionId: OLD_RUN });
    await flush();
    expect(chipRepos()).toEqual([]);
    expect(screen.queryByText(/paws-suds/)).toBeNull();
    expect(screen.queryByText("still-water-yoga-693dfbdb-bbbbbb")).toBeNull();

    await type("@engineer make the header blue");
    expect(h.send).toHaveBeenCalledTimes(1);
    const [slug, message, , extras] = h.send.mock.calls[0];
    expect(slug).toBe("engineer");
    expect(message).toBe("make the header blue");
    expect(extras).toMatchObject({ repo_hint: OLDER });
  });

  it("a plain message to Zavi on the build page carries no repo_hint (the operator ignores it and it would block 'yes' confirms)", async () => {
    mount({ kind: "build", sessionId: OLD_RUN });
    await flush();
    await type("make the header blue");
    const extras = h.send.mock.calls[0][3];
    expect(extras?.repo_hint).toBeUndefined();
  });

  it("on Home with two sites no repo is attached: no chip, and an engineer turn sends no repo_hint", async () => {
    mount();
    await flush();
    expect(chipRepos()).toEqual([]);
    expect(screen.queryByText("still-water-yoga-693dfbdb-bbbbbb")).toBeNull();
    expect(screen.queryByText("paws-suds-693dfbdb-aaaaaa")).toBeNull();
    await type("@engineer make the header blue");
    const extras = h.send.mock.calls[0][3];
    expect(extras?.repo_hint).toBeUndefined();
  });

  it("on Home with one site the chip is that site's repo and the engineer tab sends it", async () => {
    h.sessions = [TWO_SITES[1]];
    mount(undefined, "engineer");
    await flush();
    expect(chipRepos()).toEqual([]);
    expect(screen.queryByText(/paws-suds/)).toBeNull();
    await type("make the header blue");
    expect(h.send.mock.calls[0][0]).toBe("engineer");
    expect(h.send.mock.calls[0][3]).toMatchObject({ repo_hint: OLDER });
  });

  it("an engineer build page still shows the open site, not the newest one, when the sites list lands after mount", async () => {
    let release: () => void = () => {};
    h.sessionsGate = new Promise<void>((r) => {
      release = r;
    });
    mount({ kind: "build", sessionId: OLD_RUN }, "engineer");
    await flush();
    expect(chipRepos()).toEqual([]);
    expect(screen.queryByText(/still-water-yoga/)).toBeNull();
    await type("make the header blue");
    expect(h.send.mock.calls[0][3]?.repo_hint).toBeUndefined();
    await act(async () => {
      release();
    });
    await flush();
    expect(chipRepos()).toEqual([]);
    expect(screen.queryByText(/paws-suds/)).toBeNull();
    await type("make the header blue again");
    expect(h.send.mock.calls[1][3]).toMatchObject({ repo_hint: OLDER });
  });

  it("with build_site_keeps_own_repo off the chip is the workspace repo and nothing extra is sent, as before", async () => {
    h.flags = { ...ON, site_repo_chip: false };
    mount({ kind: "build", sessionId: OLD_RUN });
    await flush();
    expect(chipRepos()).toEqual([]);
    expect(screen.queryByText(/still-water-yoga/)).toBeNull();
    await type("@engineer make the header blue");
    expect(h.send.mock.calls[0][3]?.repo_hint).toBeUndefined();
  });

  it("a sessions answer that carries no flags takes each key's default (on): the chip follows the open site", async () => {
    h.flags = undefined;
    mount({ kind: "build", sessionId: OLD_RUN });
    await flush();
    expect(chipRepos()).toEqual([]);
    expect(screen.queryByText(/paws-suds/)).toBeNull();
    expect(screen.queryByText("still-water-yoga-693dfbdb-bbbbbb")).toBeNull();
  });

  it("an explicit off in the sessions answer still wins over the default", async () => {
    h.flags = { site_repo_chip: false };
    mount({ kind: "build", sessionId: OLD_RUN });
    await flush();
    expect(chipRepos()).toEqual([]);
    expect(screen.queryByText(/still-water-yoga/)).toBeNull();
  });

  describe("a tenant with its own connected GitHub repo", () => {
    const OWN = "acme/app";

    beforeEach(() => {
      h.sessions = [TWO_SITES[1]];
      h.repoDefault = OWN;
      h.repoLogin = "acme";
      h.repoList = [OWN, "acme/other"];
    });

    it("on Home with one site the chip stays the tenant's own repo, opens the picker instead of clearing, and an engineer send carries no repo_hint", async () => {
      mount(undefined, "engineer");
      await flush();
      expect(chipRepos()).toEqual([]);
      expect(screen.getAllByText(OWN).length).toBeGreaterThan(0);
      expect(screen.getByTitle("Agents work in app. Click to change.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Clear app as the repo" })).toBeNull();
      expect(screen.queryByText("paws-suds-693dfbdb-aaaaaa")).toBeNull();
      await type("make the header blue");
      expect(h.send.mock.calls[0][0]).toBe("engineer");
      expect(h.send.mock.calls[0][3]?.repo_hint).toBeUndefined();
    });

    it("an @engineer turn from the operator tab on Home carries no repo_hint either", async () => {
      mount(undefined, "operator");
      await flush();
      expect(chipRepos()).toEqual([]);
      await type("@engineer make the header blue");
      expect(h.send.mock.calls[0][0]).toBe("engineer");
      expect(h.send.mock.calls[0][3]?.repo_hint).toBeUndefined();
    });

    it("the site's own build page still uses the site repo", async () => {
      mount({ kind: "build", sessionId: OLD_RUN }, "engineer");
      await flush();
      expect(chipRepos()).toEqual([]);
      expect(screen.queryByText(/paws-suds/)).toBeNull();
      await type("make the header blue");
      expect(h.send.mock.calls[0][3]).toMatchObject({ repo_hint: OLDER });
    });

    it("while the GitHub state is still loading on Home, no site chip shows and no repo_hint is sent", async () => {
      h.repoLoading = true;
      mount(undefined, "engineer");
      await flush();
      expect(chipRepos()).toEqual([]);
      await type("make the header blue");
      expect(h.send.mock.calls[0][3]?.repo_hint).toBeUndefined();
    });
  });

  it("with no own repo (GitHub not set, or only the Zavi build connection) Home with one site uses the site repo", async () => {
    h.sessions = [TWO_SITES[1]];
    h.repoDefault = null;
    h.repoLogin = null;
    mount(undefined, "engineer");
    await flush();
    expect(chipRepos()).toEqual([]);
    expect(screen.queryByText(/paws-suds/)).toBeNull();
    await type("make the header blue");
    expect(h.send.mock.calls[0][3]).toMatchObject({ repo_hint: OLDER });
  });

  it("a non-umbrella login whose default repo is in the praxis-built org is not an own repo", async () => {
    h.sessions = [TWO_SITES[1]];
    h.repoDefault = "praxis-built/some-site";
    h.repoLogin = "someone";
    mount(undefined, "engineer");
    await flush();
    expect(chipRepos()).toEqual([]);
    expect(screen.queryByText(/paws-suds/)).toBeNull();
    await type("make the header blue");
    expect(h.send.mock.calls[0][3]).toMatchObject({ repo_hint: OLDER });
  });
});
