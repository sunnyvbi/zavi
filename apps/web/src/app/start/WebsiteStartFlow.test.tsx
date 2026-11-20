// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  query: "",
  session: false,
  userId: "user",
  home: { has_company: false, home: "/start" },
  homeError: false,
  api: vi.fn(),
  handoff: vi.fn(),
  allowed: true,
  claim: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push, replace: h.replace }),
  usePathname: () => "/start",
  useSearchParams: () => new URLSearchParams(h.query),
}));
vi.mock("next/font/local", () => ({
  default: () => ({ variable: "onboarding-font" }),
}));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    auth: {
      getSession: async () => ({
        data: {
          session: h.session
            ? { access_token: "token", user: { id: h.userId } }
            : null,
        },
      }),
    },
  }),
}));
vi.mock("@/lib/creator/api", () => ({
  creatorApi: {
    home: async () => {
      if (h.homeError) throw new Error("Account could not be read");
      return h.home;
    },
  },
}));
vi.mock("@/lib/gatekeeper", () => ({
  checkCanAddCompany: async () => h.allowed,
}));
vi.mock("@/lib/ensure-tenant-claim", () => ({
  decodeActiveTenantClaim: () => null,
  refreshSessionUntilClaim: (...args: unknown[]) => h.claim(...args),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => h.api(...args),
}));
vi.mock("./workspaceHandoff", () => ({
  goToWorkspaceWithFreshClaim: h.handoff,
}));
vi.mock("./WebsiteLearningPanel", () => ({
  WebsiteLearningPanel: () => <aside>Learning</aside>,
}));
vi.mock("./StartWebsiteStep", () => ({
  StartWebsiteStep: ({
    website,
    onWebsiteChange,
    onContinue,
    error,
  }: {
    website: string;
    onWebsiteChange: (s: string) => void;
    onContinue: () => void;
    error: string | null;
  }) => (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onContinue();
      }}
    >
      <label>
        Website URL
        <input
          value={website}
          onChange={(e) => onWebsiteChange(e.target.value)}
        />
      </label>
      <button type="submit">Start</button>
      {error && <p role="alert">{error}</p>}
    </form>
  ),
}));
vi.mock("@/components/ZaviMascot", () => ({
  ZaviMascot: () => <span>Zavi</span>,
}));
vi.mock("@/lib/analytics/events", () => ({
  trackEvent: vi.fn(),
  trackEventDeferred: vi.fn(),
}));
import { WebsiteStartFlow } from "./WebsiteStartFlow";
import { OPENING_WORKSPACE, WebsiteSignupResume } from "./WebsiteSignupResume";
import { clearWebsiteWorkspace } from "./websiteWorkspaceStorage";
import { WORKSPACE_CONNECT_APPS_ROUTE } from "@/lib/onboardingRoutes";
import { trackEvent } from "@/lib/analytics/events";
const tracked = () => vi.mocked(trackEvent).mock.calls.filter(([name]) => name !== "onboarding_step_viewed");
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
beforeEach(() => {
  clearWebsiteWorkspace("user", "example.com", false);
  clearWebsiteWorkspace("user", "example.com", true);
  localStorage.clear();
  sessionStorage.clear();
  h.query = "";
  h.session = false;
  h.userId = "user";
  h.home = { has_company: false, home: "/start" };
  h.homeError = false;
  h.allowed = true;
  h.claim.mockReset().mockResolvedValue(true);
  h.push.mockReset();
  h.replace.mockReset();
  h.handoff.mockReset();
  h.api.mockReset();
  vi.mocked(trackEvent).mockReset();
  h.api.mockImplementation(async (path: string) =>
    path === "/api/onboarding/scan"
      ? json({ scan_id: "scan-1" })
      : path.endsWith("/activate")
        ? json({ tenant_id: "tenant" })
        : path === "/api/knowledge/imports"
          ? json({ files: [] })
        : json({ ok: true }),
  );
});
afterEach(cleanup);
describe("website to signup to past-work handoff", () => {
  it("always shows the public website form at bare /start, including for signed-in accounts", async () => {
    h.session = true;
    h.home = { has_company: true, home: "/workspace" };
    h.homeError = true;
    render(<WebsiteStartFlow />);
    expect(screen.getByRole("textbox")).toBeTruthy();
    await act(async () => {});
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.api).not.toHaveBeenCalled();
  });
  it("moves old signup-return links off /start without showing its website screen", async () => {
    h.query = "website=example.com&resume=website";
    render(<WebsiteStartFlow />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/onboarding/past-work?website=example.com&resume=website"));
    expect(screen.queryByText("Learning")).toBeNull();
  });
  it("never shows Past work: it skips the step once the workspace exists and opens the setup questions", async () => {
    h.query = "website=example.com&resume=website";
    h.session = true;
    let resolveActivate!: (response: Response) => void;
    h.api.mockImplementation(async (path: string) => path.endsWith("/activate")
      ? new Promise<Response>((resolve) => { resolveActivate = resolve; })
      : json({ ok: true }));
    render(<StrictMode><WebsiteSignupResume /></StrictMode>);
    expect(screen.queryByRole("heading", { name: "Bring your past work" })).toBeNull();
    expect(screen.queryByText(/CLAUDE\.md|git log/)).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(OPENING_WORKSPACE);
    await waitFor(() => expect(resolveActivate).toBeDefined());
    expect(h.api.mock.calls.some((call) => call[0] === "/api/workspace/setup/progress")).toBe(false);
    expect(h.handoff).not.toHaveBeenCalled();
    await act(async () => resolveActivate(json({ tenant_id: "tenant" })));
    await waitFor(() => expect(h.handoff).toHaveBeenCalledWith("tenant", WORKSPACE_CONNECT_APPS_ROUTE));
    const progress = h.api.mock.calls.filter((call) => call[0] === "/api/workspace/setup/progress");
    expect(progress).toHaveLength(1);
    expect(JSON.parse(progress[0]![1].body)).toEqual({ step: "docs", outcome: "skipped" });
    expect(h.api.mock.calls.filter((call) => call[0].endsWith("/activate"))).toHaveLength(1);
    expect(h.api.mock.calls.some((call) => String(call[0]).startsWith("/api/personalization/documents"))).toBe(false);
    expect(h.handoff).toHaveBeenCalledTimes(1);
  });
  it("shows an activation failure with Try again, retries it, then opens the workspace", async () => {
    h.query = "website=example.com&resume=website";
    h.session = true;
    let fails = true;
    h.api.mockImplementation(async (path: string) => path.endsWith("/activate")
      ? (fails ? json({}, 400) : json({ tenant_id: "tenant" }))
      : json({ ok: true }));
    render(<WebsiteSignupResume />);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't set up your workspace");
    expect(h.handoff).not.toHaveBeenCalled();
    expect(h.api.mock.calls.some((call) => call[0] === "/api/workspace/setup/progress")).toBe(false);
    fails = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(h.handoff).toHaveBeenCalledWith("tenant", WORKSPACE_CONNECT_APPS_ROUTE));
    expect(h.api.mock.calls.filter((call) => call[0].endsWith("/activate"))).toHaveLength(2);
  });
  it("goes straight into the workspace when welcome setup is turned off", async () => {
    h.query = "website=example.com&resume=website";
    h.session = true;
    h.api.mockImplementation(async (path: string) => path === "/api/workspace/setup/progress"
      ? json({ error: { code: "setup_off", message: "Setup is turned off." } }, 409)
      : path.endsWith("/activate") ? json({ tenant_id: "tenant" }) : json({ ok: true }));
    render(<WebsiteSignupResume />);
    await waitFor(() => expect(h.handoff).toHaveBeenCalledWith("tenant"));
    expect(h.handoff).not.toHaveBeenCalledWith("tenant", WORKSPACE_CONNECT_APPS_ROUTE);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("a failed skip save is shown, never hands off, and Try again saves it without creating the workspace again", async () => {
    h.query = "website=example.com&resume=website";
    h.session = true;
    let progressFails = true;
    h.api.mockImplementation(async (path: string) => path === "/api/workspace/setup/progress"
      ? (progressFails ? json({}, 500) : json({ ok: true }))
      : path.endsWith("/activate") ? json({ tenant_id: "tenant" }) : json({ ok: true }));
    render(<WebsiteSignupResume />);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't save that step");
    expect(h.handoff).not.toHaveBeenCalled();
    progressFails = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(h.handoff).toHaveBeenCalledWith("tenant", WORKSPACE_CONNECT_APPS_ROUTE));
    expect(h.api.mock.calls.filter((call) => call[0] === "/api/workspace/setup/progress")).toHaveLength(2);
    expect(h.api.mock.calls.filter((call) => call[0].endsWith("/activate"))).toHaveLength(1);
  });
  it("never skips into an old session when the new tenant claim cannot be acquired", async () => {
    h.query = "website=example.com&resume=website";
    h.session = true;
    h.claim.mockResolvedValue(false);
    render(<WebsiteSignupResume />);
    await waitFor(() => expect(screen.getAllByRole("alert").some((a) => a.textContent?.includes("new workspace"))).toBe(true));
    expect(h.api.mock.calls.some((call) => call[0] === "/api/workspace/setup/progress")).toBe(false);
    expect(h.handoff).not.toHaveBeenCalled();
  });
  it("reuses the activated workspace after a reload without creating it again", async () => {
    h.query = "website=example.com&resume=website";
    h.session = true;
    h.api.mockImplementation(async (path: string) => path === "/api/workspace/setup/progress"
      ? new Promise<Response>(() => undefined)
      : path.endsWith("/activate") ? json({ tenant_id: "tenant" }) : json({ ok: true }));
    const view = render(<WebsiteSignupResume />);
    await waitFor(() => expect(h.claim).toHaveBeenCalled());
    await waitFor(() => expect(h.api.mock.calls.some((call) => call[0] === "/api/workspace/setup/progress")).toBe(true));
    view.unmount();
    h.home = { has_company: true, home: "/workspace" };
    render(<WebsiteSignupResume />);
    await waitFor(() => expect(h.claim).toHaveBeenCalledTimes(2));
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.api.mock.calls.filter((call) => call[0].endsWith("/activate"))).toHaveLength(1);
  });
  it("server-renders the opening status (never Past work) and hydrates it", async () => {
    h.query = "website=example.com&resume=website";
    h.session = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = renderToString(<WebsiteSignupResume />);
    expect(html).toContain(OPENING_WORKSPACE);
    expect(html).not.toContain("Bring your past work");
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => { root = hydrateRoot(container, <WebsiteSignupResume />); });
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/hydrat|did not match/i);
    await act(async () => root.unmount());
    container.remove();
    errors.mockRestore();
  });
  it("never scans while the visitor types", async () => {
    render(<WebsiteStartFlow />);
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "example.com" } });
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(h.api).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });
  it("activates at once with background memory and the scan id from the link, never generating memory first", async () => {
    h.query = "website=example.com&resume=website&scan=scan-abc";
    h.session = true;
    render(<WebsiteSignupResume />);
    await waitFor(() => expect(h.api.mock.calls.some((call) => call[0].endsWith("/activate"))).toBe(true));
    expect(h.api.mock.calls.map((c) => c[0]).filter((path) => path.startsWith("/api/onboarding/") && !path.startsWith("/api/onboarding/scan/"))).toEqual([
      "/api/onboarding/activate", "/api/onboarding/start-card-email",
    ]);
    const body = JSON.parse(h.api.mock.calls.find((call) => call[0].endsWith("/activate"))![1].body);
    expect(body).toMatchObject({
      display_name: "Example",
      memory: {},
      background_memory: true,
      scan_id: "scan-abc",
      onboarding_meta: { wizard: { orgName: "Example", website: "example.com" } },
      additional: false,
    });
    expect(body.onboarding_meta.wizard).not.toHaveProperty("marketplaceShape");
    expect(body.onboarding_meta.wizard).not.toHaveProperty("stage");
    await waitFor(() => expect(h.handoff).toHaveBeenCalledWith("tenant", WORKSPACE_CONNECT_APPS_ROUTE));
  });
  it("starts the scan and leaves for signup without waiting for it, never showing the long research wait", async () => {
    h.api.mockImplementation(async (path: string) => path === "/api/onboarding/scan" ? json({ scan_id: "scan-1" }) : json({ ok: true }));
    h.query = "website=example.com";
    render(<WebsiteStartFlow />);
    expect(screen.queryByText(/Getting to know your business/)).toBeNull();
    await waitFor(() => expect(h.replace).toHaveBeenCalled());
    expect(screen.queryByText(/Getting to know your business/)).toBeNull();
    expect(h.api.mock.calls.map((call) => call[0])).toEqual(["/api/onboarding/scan"]);
    expect(JSON.parse(h.api.mock.calls[0][1].body)).toEqual({ website: "example.com" });
    const login = new URL(h.replace.mock.calls[0][0], "https://zavi.test");
    const next = new URL(login.searchParams.get("next")!, "https://zavi.test");
    expect(next.searchParams.get("scan")).toBe("scan-1");
  });
  it("reuses a scan id already in the link instead of starting another scan", async () => {
    h.query = "website=example.com&scan=scan-old";
    render(<WebsiteStartFlow />);
    await waitFor(() => expect(h.replace).toHaveBeenCalled());
    expect(h.api).not.toHaveBeenCalled();
    const next = new URL(new URL(h.replace.mock.calls[0][0], "https://zavi.test").searchParams.get("next")!, "https://zavi.test");
    expect(next.searchParams.get("scan")).toBe("scan-old");
  });
  it("starts the scan before opening unchanged signup, carrying the website, scan and add-company attribution", async () => {
    h.query = "new=1&from=live-demo&ref=challenge";
    const view = render(<WebsiteStartFlow />);
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "https://www.example.com/pricing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const start = new URL(h.push.mock.calls[0][0], "https://zavi.test");
    expect(start.pathname).toBe("/start");
    h.query = start.searchParams.toString();
    view.rerender(<WebsiteStartFlow />);
    await waitFor(() => expect(h.replace).toHaveBeenCalled());
    const login = new URL(h.replace.mock.calls[0][0], "https://zavi.test");
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("signup")).toBe("1");
    const next = new URL(login.searchParams.get("next")!, "https://zavi.test");
    expect(Object.fromEntries(next.searchParams)).toMatchObject({
      website: "example.com",
      resume: "website",
      new: "1",
      from: "live-demo",
      ref: "challenge",
    });
    expect(next.searchParams.get("scan")).toBe("scan-1");
    expect(h.api.mock.calls.map((call) => call[0])).toEqual(["/api/onboarding/scan"]);
  });
  it("starts the scan for a website submitted on the home page before signup", async () => {
    h.query = "website=example.com";
    render(<WebsiteStartFlow />);
    await waitFor(() => expect(h.replace).toHaveBeenCalled());
    const login = new URL(h.replace.mock.calls[0][0], "https://zavi.test");
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("next")).toBe(
      "/onboarding/past-work?website=example.com&scan=scan-1&resume=website",
    );
    expect(h.api.mock.calls.map((call) => call[0])).toEqual(["/api/onboarding/scan"]);
  });
  it("requires authentication on signup return without replaying public research", async () => {
    h.query = "website=example.com&resume=website";
    render(<WebsiteSignupResume />);
    await waitFor(() => expect(h.replace).toHaveBeenCalled());
    expect(h.replace.mock.calls[0][0]).toMatch(/^\/login\?signup=1&next=/);
    expect(h.api).not.toHaveBeenCalled();
  });
  it("signed-in add-company: starts the scan and goes straight to Past work with its id", async () => {
    h.query = "website=example.com&new=1";
    h.session = true;
    h.home = { has_company: true, home: "/workspace" };
    render(<WebsiteStartFlow />);
    await waitFor(() => expect(h.replace).toHaveBeenCalled());
    const next = new URL(h.replace.mock.calls[0][0], "https://zavi.test");
    expect(next.pathname).toBe("/onboarding/past-work");
    expect(next.searchParams.get("scan")).toBe("scan-1");
    expect(next.searchParams.get("new")).toBe("1");
    expect(h.api.mock.calls.map((call) => call[0])).toEqual(["/api/onboarding/scan"]);
  });
  it("continues to signup without a scan id when the scan cannot start", async () => {
    for (const failure of [async () => json({}, 503), async () => json({ scan_id: null, reason: "rate_limited" }), async () => { throw new TypeError("Failed to fetch"); }]) {
      cleanup();
      h.replace.mockReset();
      h.api.mockReset();
      h.api.mockImplementation(async (path: string) => path === "/api/onboarding/scan" ? failure() : json({ ok: true }));
      h.query = "website=example.com";
      render(<WebsiteStartFlow />);
      await waitFor(() => expect(h.replace).toHaveBeenCalled());
      const login = new URL(h.replace.mock.calls[0][0], "https://zavi.test");
      expect(login.pathname).toBe("/login");
      expect(login.searchParams.get("next")).toBe("/onboarding/past-work?website=example.com&resume=website");
      expect(h.api).toHaveBeenCalledTimes(1);
    }
  });
  it("replays activation only when a durable attempt proves the prior response was lost", async () => {
    h.query = "website=example.com&resume=website";
    h.session = true;
    h.api.mockImplementation(async (path: string) => {
      if (path.endsWith("/activate")) throw new TypeError("response lost");
      return json({ files: [] });
    });
    const first = render(<WebsiteSignupResume />);
    await screen.findByRole("alert");
    first.unmount();
    h.home = { has_company: true, home: "/workspace" };
    h.api.mockImplementation(async (path: string) => path.endsWith("/activate") ? json({ tenant_id: "tenant-recovered" }) : json({ files: [] }));
    render(<WebsiteSignupResume />);
    await waitFor(() => expect(h.api.mock.calls.filter((call) => call[0].endsWith("/activate"))).toHaveLength(2));
    await waitFor(() => expect(h.claim).toHaveBeenCalled());
    expect(h.replace).not.toHaveBeenCalledWith("/workspace");
    const keys = h.api.mock.calls.filter((call) => call[0].endsWith("/activate")).map((call) => call[1].headers?.["Idempotency-Key"]);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });
  it("does not create a tenant when an account lookup fails", async () => {
    h.query = "website=example.com&resume=website";
    h.session = true;
    h.homeError = true;
    render(<WebsiteSignupResume />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(h.api).not.toHaveBeenCalled();
  });
  it("keeps activation errors on screen, never hands off, and retries setup explicitly", async () => {
    h.query = "website=example.com&resume=website";
    h.session = true;
    h.api.mockImplementation(async (path: string) => path === "/api/knowledge/imports" ? json({ files: [] }) : json({}, 500));
    render(<WebsiteSignupResume />);
    await screen.findByRole("button", { name: "Try again" });
    expect(h.handoff).not.toHaveBeenCalled();
    h.api.mockImplementation(async (path: string) => path === "/api/knowledge/imports" ? json({ files: [] }) : json({ tenant_id: "tenant" }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(h.handoff).toHaveBeenCalledWith("tenant", WORKSPACE_CONNECT_APPS_ROUTE));
    expect(h.handoff).toHaveBeenCalledTimes(1);
  });
  it("shows the workspace creation limit with Try again", async () => {
    h.query = "website=example.com&resume=website";
    h.session = true;
    h.api.mockImplementation(async () =>
      json({ error: { code: "workspace_limit", message: "Too many new workspaces from this network. Please try again in an hour." } }, 429),
    );
    render(<WebsiteSignupResume />);
    expect((await screen.findByRole("alert")).textContent).toContain("Please try again in an hour");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(h.api.mock.calls.filter((call) => call[0].endsWith("/activate"))).toHaveLength(1);
  });
  it("re-authenticates on a 401 without activating a tenant", async () => {
    h.query = "website=example.com&resume=website";
    h.session = true;
    h.api.mockResolvedValue(json({}, 401));
    render(<WebsiteSignupResume />);
    await waitFor(() => expect(h.replace).toHaveBeenCalled());
    expect(h.api).toHaveBeenCalledTimes(1);
    expect(h.handoff).not.toHaveBeenCalled();
  });
  it("opens an existing account's setup without creating a second company", async () => {
    h.query = "website=example.com&resume=website";
    h.session = true;
    h.home = { has_company: true, home: "/workspace" };
    render(<WebsiteSignupResume />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/workspace"));
    expect(h.api).not.toHaveBeenCalled();
  });
  it("retains the additional-company guard", async () => {
    h.query = "website=example.com&resume=website&new=1";
    h.session = true;
    h.home = { has_company: true, home: "/workspace" };
    h.allowed = false;
    render(<WebsiteSignupResume />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/workspace"));
    expect(h.api).not.toHaveBeenCalled();
  });
  it("hydrates with the same server-safe session-check screen", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = renderToString(<WebsiteStartFlow />);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <WebsiteStartFlow />);
    });
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(
      /hydrat|did not match/i,
    );
    await act(async () => root.unmount());
    container.remove();
    errors.mockRestore();
  });
});

describe("website onboarding funnel events", () => {
  it("homepage box website: counts the submit as prefilled, then the signup prompt", async () => {
    h.query = "website=example.com";
    render(<WebsiteStartFlow />);
    await waitFor(() => expect(h.replace).toHaveBeenCalled());
    expect(tracked()).toEqual([
      ["onboarding_website_submitted", { prefilled_from_home: true }],
      ["onboarding_signup_prompted", { path: "website" }],
    ]);
  });
  it("website typed on /start itself is not counted as prefilled", async () => {
    const view = render(<WebsiteStartFlow />);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    h.query = new URL(h.push.mock.calls[0][0], "https://zavi.test").searchParams.toString();
    view.rerender(<WebsiteStartFlow />);
    await waitFor(() => expect(h.replace).toHaveBeenCalled());
    expect(tracked()[0]).toEqual(["onboarding_website_submitted", { prefilled_from_home: false }]);
  });
  it("a reload that already carries a scan id counts nothing twice", async () => {
    h.query = "website=example.com&scan=scan-old";
    render(<WebsiteStartFlow />);
    await waitFor(() => expect(h.replace).toHaveBeenCalled());
    expect(tracked()).toEqual([["onboarding_signup_prompted", { path: "website" }]]);
  });
  it("a scan that cannot start is reported as a failed scan", async () => {
    h.api.mockImplementation(async (path: string) => path === "/api/onboarding/scan" ? json({}, 503) : json({ ok: true }));
    h.query = "website=example.com";
    render(<WebsiteStartFlow />);
    await waitFor(() => expect(h.replace).toHaveBeenCalled());
    expect(tracked()).toContainEqual(["onboarding_scan_completed", { status: "failed", reason: "start_failed" }]);
  });
});
