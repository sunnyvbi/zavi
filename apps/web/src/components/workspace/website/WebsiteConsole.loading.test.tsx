// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
const ws = vi.hoisted(() => ({ role: "owner" }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ role: ws.role, openTab: vi.fn() }),
}));

import { RowsBrowser, UsersView, WebsiteConsole, __resetAppCatalogInflight } from "./WebsiteConsole";
import { SITE_FUNCTIONS_TIMEOUT_MS } from "./SiteFunctionsSettings";
import { __resetBuildSessionsForTest } from "@/lib/workspace/useBuildSessions";

const RUN = "aaaaaaaa-1111-4000-8000-00000000000a";

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const siteOverview = () => ({
  app: { name: "Lucky Paws", description: null, created_at: "2026-10-01T00:00:00Z", deployed_url: "https://lucky-paws.zavi.site", build_status: "done" },
  visibility: null,
  badge_hidden: null,
  site: { id: "site-a", hostname: "lucky-paws.zavi.site", status: "live" },
});

const siteFunctions = () => ({
  secrets: { secrets: [], required: [] },
  functions: [{ name: "nightly", kind: "schedule", url: null, cron: "0 3 * * *", enabled: true, last_run: null }],
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let sessionsBody: { sessions: unknown[] } = { sessions: [] };
let overview: ReturnType<typeof deferred<Response>>;
let functions: ReturnType<typeof deferred<Response>>;

beforeEach(() => {
  ws.role = "owner";
  sessionsBody = { sessions: [] };
  __resetBuildSessionsForTest();
  apiFetch.mockReset();
  __resetAppCatalogInflight();
  overview = deferred<Response>();
  functions = deferred<Response>();
  apiFetch.mockImplementation((url: string) => {
    if (url.startsWith("/api/website/overview")) return overview.promise;
    if (url.startsWith("/api/website/site-functions?")) return functions.promise;
    if (url.startsWith("/api/workspace/autopilot/build-sessions")) return Promise.resolve(json(200, sessionsBody));
    return Promise.resolve(json(404, {}));
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

const busy = () => Array.from(document.querySelectorAll("[aria-busy='true']"));

describe("Build Settings console while loading", () => {
  it.each(["analytics", "seo", "payments"])("falls back to Overview for the removed %s section", async (section) => {
    window.history.replaceState(null, "", `/workspace?section=${section}`);
    render(<WebsiteConsole buildSessionId={RUN} />);

    expect(screen.getByRole("status", { name: "Loading overview" })).toBeTruthy();
    await act(async () => overview.resolve(json(200, siteOverview())));
    expect(await screen.findByRole("heading", { name: "Lucky Paws" })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("section")).toBe("overview");
  });

  it("a reload on Schedules shows the Schedules skeleton from the first frame and keeps it until the jobs arrive", async () => {
    window.history.replaceState(null, "", "/workspace?tab=build&view=dashboard&section=schedules");
    render(<WebsiteConsole buildSessionId={RUN} />);

    const first = screen.getByRole("status", { name: "Loading schedules" });
    expect(first.querySelectorAll("li[data-skeleton-row]").length).toBe(3);
    expect(screen.queryByRole("status", { name: "Loading overview" })).toBeNull();
    expect(document.querySelector(".animate-pulse")).toBeNull();
    expect(screen.getByRole("heading", { name: "Schedules" })).toBeTruthy();

    await act(async () => overview.resolve(json(200, siteOverview())));
    const second = screen.getByRole("status", { name: "Loading schedules" });
    expect(second.querySelectorAll("li[data-skeleton-row]").length).toBe(3);
    expect(document.querySelector(".h-24.animate-pulse")).toBeNull();
    expect(busy()).toHaveLength(1);

    await act(async () => functions.resolve(json(200, siteFunctions())));
    expect(await screen.findByText("nightly")).toBeTruthy();
    expect(busy()).toHaveLength(0);
    expect(screen.getAllByRole("heading", { name: "Schedules" })).toHaveLength(1);
  });

  it("a reload on Domains shows a domains-shaped skeleton, then the site address", async () => {
    window.history.replaceState(null, "", "/workspace?section=domains");
    render(<WebsiteConsole buildSessionId={RUN} />);

    const status = screen.getByRole("status", { name: "Loading domains" });
    expect(status.querySelectorAll("[data-skeleton-row]").length).toBe(2);
    expect(status.querySelectorAll(".animate-shimmer").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Domains" })).toBeTruthy();

    await act(async () => overview.resolve(json(200, siteOverview())));
    expect(await screen.findByTestId("site-address")).toBeTruthy();
    expect(busy()).toHaveLength(0);
  });

  it("Overview shows an overview-shaped skeleton on theme tokens, not flat hardcoded grey blocks", async () => {
    render(<WebsiteConsole buildSessionId={RUN} />);

    const status = screen.getByRole("status", { name: "Loading overview" });
    expect(status.className).toContain("max-w-[840px]");
    expect(status.querySelectorAll("[data-skeleton-row]").length).toBe(5);
    for (const s of Array.from(status.querySelectorAll(".animate-shimmer"))) expect(s.className).toContain("motion-reduce:hidden");
    expect(status.querySelector(".animate-pulse")).toBeNull();
    expect(status.querySelector(".bg-\\[\\#f0f0f0\\], .bg-\\[\\#f4f4f4\\], .bg-\\[\\#f7f7f7\\]")).toBeNull();

    await act(async () => overview.resolve(json(200, siteOverview())));
    expect(await screen.findByRole("heading", { name: "Lucky Paws" })).toBeTruthy();
    expect(busy()).toHaveLength(0);
  });

  it("an overview read that never answers ends in the error message, not an endless skeleton", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    apiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/website/overview")) {
        if (init?.signal) signals.push(init.signal);
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }
      return Promise.resolve(json(404, {}));
    });
    window.history.replaceState(null, "", "/workspace?section=schedules");
    render(<WebsiteConsole buildSessionId={RUN} />);
    expect(screen.getByRole("status", { name: "Loading schedules" })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SITE_FUNCTIONS_TIMEOUT_MS);
    });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(screen.getByText(/couldn.t load your app details/)).toBeTruthy();
    expect(busy()).toHaveLength(0);
  });
});

const skeletonRows = () => screen.getByTestId("console-nav-skeleton").children.length;

const navLabels = () =>
  Array.from(screen.getByRole("navigation").querySelectorAll("button[aria-current], button:not([aria-label])"))
    .map((b) => b.textContent?.trim())
    .filter(Boolean);

const workspaceOverview = () => ({
  app: { name: "Bikes", description: null, created_at: "2026-10-01T00:00:00Z", deployed_url: null, build_status: "done" },
  visibility: null,
  badge_hidden: null,
  site: null,
});

describe("Build Settings nav while the overview is in flight", () => {
  it("never shows the workspace app's Users and Data to a site, not even for the first frames", async () => {
    const seen = new Set<string>();
    const observer = new MutationObserver(() => {
      for (const label of navLabels()) seen.add(label!);
    });
    render(<WebsiteConsole buildSessionId={RUN} />);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    for (const label of navLabels()) seen.add(label!);

    const nav = screen.getByRole("navigation");
    expect(navLabels()).toEqual(["Overview"]);
    expect(nav.getAttribute("aria-busy")).toBe("true");
    expect(skeletonRows()).toBe(4);

    await act(async () => overview.resolve(json(200, siteOverview())));
    observer.disconnect();
    expect(navLabels()).toEqual(["Overview", "Domains", "Secrets", "Functions", "Schedules"]);
    expect(seen.has("Users")).toBe(false);
    expect(seen.has("Data")).toBe(false);
    expect(nav.getAttribute("aria-busy")).toBeNull();
    expect(screen.queryByTestId("console-nav-skeleton")).toBeNull();
  });

  it("the nav skeleton holds as many rows as the site nav that replaces it, so the nav never grows", async () => {
    render(<WebsiteConsole buildSessionId={RUN} />);
    await act(async () => {});
    const placeholders = skeletonRows();
    await act(async () => overview.resolve(json(200, siteOverview())));
    expect(navLabels().length - 1).toBe(placeholders);
  });

  it("a site member's skeleton holds only the rows they will get", async () => {
    ws.role = "member";
    render(<WebsiteConsole buildSessionId={RUN} />);
    await act(async () => {});
    expect(skeletonRows()).toBe(1);
    await act(async () => overview.resolve(json(200, siteOverview())));
    expect(navLabels()).toEqual(["Overview", "Domains"]);
  });

  it("a session the list already knows is the workspace app gets that app's row count", async () => {
    sessionsBody = { sessions: [{ id: RUN, title: "Bikes", state: "ready", run_status: "done" }] };
    render(<WebsiteConsole buildSessionId={RUN} />);
    await act(async () => {});
    expect(skeletonRows()).toBe(3);
    await act(async () => overview.resolve(json(200, workspaceOverview())));
    expect(navLabels().length - 1).toBe(3);
  });

  it("a workspace-app session gets Users and Data once the server says so", async () => {
    render(<WebsiteConsole buildSessionId={RUN} />);
    expect(navLabels()).toEqual(["Overview"]);
    await act(async () => overview.resolve(json(200, workspaceOverview())));
    expect(navLabels()).toEqual(["Overview", "Users", "Data", "Domains"]);
  });

  it("a failed overview leaves Overview alone in the nav, with no skeleton left pulsing", async () => {
    render(<WebsiteConsole buildSessionId={RUN} />);
    await act(async () => overview.resolve(json(500, {})));
    expect(screen.getByText(/couldn.t load your app details/)).toBeTruthy();
    expect(navLabels()).toEqual(["Overview"]);
    expect(screen.queryByTestId("console-nav-skeleton")).toBeNull();
    expect(busy()).toHaveLength(0);
  });

  it("the Website tab console, which has no build session, shows its own nav from the first frame", () => {
    render(<WebsiteConsole />);
    expect(navLabels()).toEqual(["Overview", "Users", "Data", "Domains"]);
    expect(screen.queryByTestId("console-nav-skeleton")).toBeNull();
  });
});

describe("Data and Users table skeletons", () => {
  const usersCatalog = {
    connected: true,
    dialect: "postgres",
    tables: [{ name: "users", row_estimate: null, columns: [{ name: "id", type: "uuid", nullable: false }, { name: "email", type: "text", nullable: false }] }],
  };

  it("the Data rows browser loads on the shared theme skeleton, announced as busy", () => {
    apiFetch.mockImplementation(() => new Promise(() => {}));
    render(
      <RowsBrowser
        table={{ name: "listings", row_estimate: 3, columns: [{ name: "title", type: "text", nullable: false }], primary_key: ["id"], writable: true } as never}
        canWrite
      />,
    );
    const status = screen.getByRole("status", { name: "Loading rows" });
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.querySelectorAll(".animate-shimmer").length).toBe(7);
    expect(document.querySelector(".animate-pulse")).toBeNull();
    expect(status.querySelector(".bg-\\[\\#f4f4f4\\], .bg-\\[\\#fafafa\\]")).toBeNull();
  });

  it("the Users table's first load is the shared skeleton, announced as busy, until the rows land", async () => {
    let releaseRows!: () => void;
    apiFetch.mockImplementation((url: string) => {
      if (url.includes("/app-catalog")) return Promise.resolve(json(200, usersCatalog));
      if (url.includes("/app-rows")) {
        return new Promise((resolve) => {
          releaseRows = () =>
            resolve(
              json(200, {
                connected: true,
                supported: true,
                dialect: "postgres",
                table: "users",
                columns: usersCatalog.tables[0]!.columns,
                rows: [{ id: "u1", email: "rider@example.com" }],
                row_keys: [{ id: "u1" }],
                row_versions: ["1"],
                has_more: false,
                masked_columns: [],
                writable: true,
              }),
            );
        });
      }
      return Promise.resolve(json(404, {}));
    });
    render(<UsersView deployedUrl="https://app.example.com" />);
    const status = await screen.findByRole("status", { name: "Loading users" });
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.querySelectorAll(".animate-shimmer").length).toBe(4);
    expect(document.querySelector(".animate-pulse")).toBeNull();

    await act(async () => releaseRows());
    expect(await screen.findByText("rider@example.com")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading users" })).toBeNull();
  });
});

describe("app catalog read failure", () => {
  it("ends in the Users error state without leaving an unhandled rejection behind", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      apiFetch.mockImplementation(() => Promise.resolve(json(500, {})));
      render(<UsersView deployedUrl="https://app.example.com" />);
      await act(async () => {
        for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
      });
      expect(apiFetch.mock.calls.some(([u]) => String(u).includes("/app-catalog"))).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
