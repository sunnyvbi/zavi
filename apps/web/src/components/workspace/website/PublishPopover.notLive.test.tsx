// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/components/ui/toast", () => ({ toast: { add: vi.fn(), update: vi.fn(), close: vi.fn() } }));
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var" } }));

import { DomainsView } from "./WebsiteConsole";
import { BUILTIN_BLOCKED_TITLE, BUILTIN_NOT_LIVE_COPY, PublishPopover, type SitePublishOnRequest } from "./PublishPopover";

const HOST = "apna-tutor-693dfbdb.zaviagent.com";
const URL_ADDR = `https://${HOST}`;

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function wire(status: string) {
  apiFetch.mockImplementation(async (url: string) => {
    if (url === "/api/website/builtin-url")
      return ok({
        builtin: { label: "apna-tutor-693dfbdb", hostname: HOST, url: URL_ADDR, status, dns_ready: true },
        base_domain: "zaviagent.com",
        custom_domain_attached: false,
      });
    if (url === "/api/website/custom-domains") return ok({ domains: [] });
    if (url === "/api/website/overview?app=workspace") return ok({ visibility: "public" });
    if (url.startsWith("/api/website/publish-status")) return ok({ pending: 0, published: 0, last_published_at: null });
    if (url.startsWith("/api/website/pending")) return ok({ items: [] });
    return ok({});
  });
}

async function popover(props: {
  appUrl: string | null;
  appHost: string | null;
  publishable: boolean;
  ownBuildApp?: boolean;
  site?: { liveUrl: string | null; status: string } | null;
  sitePublish?: SitePublishOnRequest | null;
}) {
  render(
    <div data-testid="popover">
      <PublishPopover onGetDomain={() => {}} onClose={() => {}} {...props} />
    </div>,
  );
  await waitFor(() => expect(screen.queryByLabelText("Loading publish options")).toBeNull());
  return within(screen.getByTestId("popover"));
}

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

describe("Publish and Domains agree an address whose build has not shipped is not Live", () => {
  it("QA 13:39: Domains shows Not live yet, never Live, and Publish shows the same", async () => {
    wire("not_live");
    render(<DomainsView deployedUrl={null} />);
    await screen.findByText(BUILTIN_BLOCKED_TITLE);
    expect(screen.getByText(BUILTIN_NOT_LIVE_COPY)).toBeTruthy();
    expect(screen.queryByText("Live")).toBeNull();
    expect(screen.queryByText("Setting up…")).toBeNull();
    cleanup();

    wire("not_live");
    const pop = await popover({ appUrl: null, appHost: null, publishable: false });
    expect(pop.getByText(BUILTIN_BLOCKED_TITLE)).toBeTruthy();
    expect(pop.getByText(BUILTIN_NOT_LIVE_COPY)).toBeTruthy();
    expect(pop.queryByText("Live")).toBeNull();
    expect(pop.queryByText("Not published")).toBeNull();
    expect(pop.queryByLabelText("Copy link")).toBeNull();
  });

  it("a Zavi-built app view does not offer the hosting URL as live or let Publish run mid-build", async () => {
    wire("not_live");
    const pop = await popover({ appUrl: "https://tutor.onrender.com", appHost: "tutor.onrender.com", publishable: true });
    expect(pop.getByText(BUILTIN_BLOCKED_TITLE)).toBeTruthy();
    expect(pop.queryByText("Live")).toBeNull();
    expect(pop.queryByLabelText("Copy link")).toBeNull();
    const publish = pop.getByRole("button", { name: "Publish" });
    expect(publish).toHaveProperty("disabled", true);
  });

  it("B21: mid-build, the app view on its unshipped hosting URL reads Not live yet, never Up to date", async () => {
    wire("not_live");
    const pop = await popover({
      appUrl: "https://cake-co.onrender.com",
      appHost: "cake-co.onrender.com",
      publishable: false,
      ownBuildApp: true,
    });
    expect(apiFetch.mock.calls.some(([url]) => url === "/api/website/builtin-url")).toBe(true);
    expect(pop.getByText(BUILTIN_BLOCKED_TITLE)).toBeTruthy();
    expect(pop.getByText(BUILTIN_NOT_LIVE_COPY)).toBeTruthy();
    expect(pop.queryByText("Live")).toBeNull();
    expect(pop.queryByText(/Live on the web/)).toBeNull();
    expect(pop.queryByText("Up to date")).toBeNull();
    expect(pop.queryByText(/cake-co\.onrender\.com/)).toBeNull();
    expect(pop.queryByLabelText("Copy link")).toBeNull();
    expect(pop.queryByLabelText("More options")).toBeNull();
    expect(screen.getByTestId("popover").querySelector("a[href]")).toBeNull();
  });

  it("B21: mid-build with no Zavi address yet, the unshipped hosting URL still never reads Live", async () => {
    apiFetch.mockImplementation(async (url: string) => {
      if (url === "/api/website/builtin-url") return ok({ builtin: null, base_domain: "zaviagent.com", custom_domain_attached: false });
      if (url === "/api/website/overview?app=workspace") return ok({ visibility: "public" });
      return ok({});
    });
    const pop = await popover({
      appUrl: "https://cake-co.onrender.com",
      appHost: "cake-co.onrender.com",
      publishable: false,
      ownBuildApp: true,
    });
    expect(pop.getByText(BUILTIN_BLOCKED_TITLE)).toBeTruthy();
    expect(pop.queryByText("Live")).toBeNull();
    expect(pop.queryByText("Up to date")).toBeNull();
    expect(pop.queryByText(/cake-co\.onrender\.com/)).toBeNull();
    expect(pop.queryByLabelText("Copy link")).toBeNull();
  });

  it("once the build ships the same address reads Live in both places", async () => {
    wire("live");
    render(<DomainsView deployedUrl={null} />);
    await screen.findByText("Live");
    cleanup();
    wire("live");
    const pop = await popover({ appUrl: null, appHost: null, publishable: false });
    expect(pop.getByText("Live")).toBeTruthy();
  });
});

describe("B21 on a new-flow site: the popover never borrows the workspace's old address", () => {
  it("a site still building, shown on its own build app, reads Not live yet and never fetches or shows the old built-in address", async () => {
    wire("live");
    const pop = await popover({
      appUrl: "https://bakery-preview.e2b.app",
      appHost: "bakery-preview.e2b.app",
      publishable: false,
      ownBuildApp: true,
      site: { liveUrl: null, status: "building" },
    });
    expect(apiFetch.mock.calls.some(([url]) => url === "/api/website/builtin-url")).toBe(false);
    expect(pop.getByText("Not live yet")).toBeTruthy();
    expect(pop.getByText("Your site goes live when its build finishes")).toBeTruthy();
    expect(screen.getByTestId("popover").textContent).not.toContain("apna-tutor");
    expect(pop.queryByText(BUILTIN_NOT_LIVE_COPY)).toBeNull();
    expect(pop.queryByLabelText("Copy link")).toBeNull();
  });

  it("a live site shows its own address, not the old built-in one, even while its build app is on screen", async () => {
    wire("live");
    const pop = await popover({
      appUrl: "https://bakery-preview.e2b.app",
      appHost: "bakery-preview.e2b.app",
      publishable: false,
      ownBuildApp: true,
      site: { liveUrl: "https://bakery.zaviagent.com", status: "live" },
    });
    expect(apiFetch.mock.calls.some(([url]) => url === "/api/website/builtin-url")).toBe(false);
    expect(screen.getByTestId("popover").textContent).toContain("bakery.zaviagent.com");
    expect(screen.getByTestId("popover").textContent).not.toContain("apna-tutor");
  });
});

describe("publish on request: a never-published site is published from the popover, and only from there", () => {
  const SITE_HOST = "bakery-693dfbdb.zaviagent.com";
  const SITE_PUBLISH = "/api/workspace/autopilot/sites/site-1/publish";
  const posts = (path: string) =>
    apiFetch.mock.calls.filter(([url, init]) => url === path && (init as RequestInit | undefined)?.method === "POST");
  const refused = (status: number, body: unknown) => ({ ok: false, status, json: async () => body }) as Response;

  function wireSitePublish(reply: () => Promise<Response> | Response) {
    apiFetch.mockImplementation(async (url: string) => {
      if (url === SITE_PUBLISH) return reply();
      return ok({});
    });
  }

  function sitePopover(over: Partial<SitePublishOnRequest> = {}, siteStatus = "building") {
    const onStarted = vi.fn();
    const onRefresh = vi.fn();
    const props = {
      appUrl: "https://bakery-preview.e2b.app",
      appHost: "bakery-preview.e2b.app",
      publishable: false,
      ownBuildApp: true,
      site: { liveUrl: null, status: siteStatus },
      sitePublish: { siteId: "site-1", hostname: SITE_HOST, built: true, status: "none" as const, onStarted, onRefresh, ...over },
    };
    return popover(props).then((pop) => ({ pop, onStarted, onRefresh }));
  }

  const neverClaimsLive = () => {
    const root = screen.getByTestId("popover");
    expect(within(root).queryByText("Live")).toBeNull();
    expect(root.textContent).not.toMatch(/Live on the web|Up to date|is live/);
    expect(within(root).queryByLabelText("Copy link")).toBeNull();
    expect(within(root).queryByLabelText("More options")).toBeNull();
    expect(root.querySelector("a[href]")).toBeNull();
  };

  it("shows Not published with the planned address, and a double click on Publish starts exactly one publish", async () => {
    let release: (value: Response) => void = () => {};
    wireSitePublish(() => new Promise<Response>((resolve) => (release = resolve)));
    const { pop, onStarted } = await sitePopover();

    expect(pop.getByText("Not published")).toBeTruthy();
    expect(pop.getByText("Publish to put your site on its address.")).toBeTruthy();
    expect(screen.getByTestId("popover").textContent).toContain(SITE_HOST);
    expect(pop.queryByText("Not live yet")).toBeNull();
    expect(pop.queryByText(/goes live when its build finishes/)).toBeNull();
    neverClaimsLive();

    const publish = pop.getByRole("button", { name: "Publish" }) as HTMLButtonElement;
    expect(publish.disabled).toBe(false);
    act(() => {
      publish.click();
      publish.click();
    });
    fireEvent.click(publish);
    expect(posts(SITE_PUBLISH)).toHaveLength(1);
    expect(onStarted).not.toHaveBeenCalled();

    await act(async () => {
      release(ok({ ok: true, conductor_run_id: "run-9" }));
    });
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    const publishing = pop.getByRole("button", { name: "Publishing…" }) as HTMLButtonElement;
    expect(publishing.disabled).toBe(true);
    fireEvent.click(publishing);
    expect(posts(SITE_PUBLISH)).toHaveLength(1);
    expect(posts("/api/website/publish")).toHaveLength(0);
    expect(posts("/api/website/builtin-url/ensure")).toHaveLength(0);
    expect(apiFetch.mock.calls.some(([url]) => url === "/api/website/builtin-url")).toBe(false);
    neverClaimsLive();
  });

  it.each([
    [403, "forbidden", "Viewers can't publish. Ask a workspace owner, admin or member."],
    [403, "product_builder_disabled", "Building sites isn't turned on for this workspace."],
    [404, "site_not_found", "We couldn't find this site. Reload the page and try again."],
    [409, "build_already_in_progress", "A build or publish is already running in this workspace. Try again when it finishes."],
    [409, "sandbox_gone", "Your site's workspace has expired. Ask for any change in the chat, then publish."],
    [409, "site_unavailable", "This site is still being set up, so there is nothing to publish yet."],
    [429, "daily_build_limit_reached", "You've reached today's limit for changes. You can publish tomorrow."],
    [402, "provision_budget_exceeded", "This workspace is out of build budget for today."],
    [502, "site_head_unreadable", "We couldn't publish your site. Try again."],
    [500, "publish_failed", "We couldn't publish your site. Try again."],
    [400, "bad_request", "We couldn't publish your site. Try again."],
    [409, "some_new_conflict", "We couldn't publish your site. Try again."],
  ])("a %i %s refusal says why in plain words, leaves Publish usable and never claims the site is live", async (status, code, message) => {
    wireSitePublish(() => refused(status, { error: { code, message: "server words nobody should read" } }));
    const { pop, onStarted, onRefresh } = await sitePopover();
    fireEvent.click(pop.getByRole("button", { name: "Publish" }));
    const alert = await pop.findByRole("alert");
    expect(alert.textContent).toContain(message);
    const text = screen.getByTestId("popover").textContent ?? "";
    expect(text).not.toContain(code);
    expect(text).not.toContain("server words");
    if (code !== "build_already_in_progress") expect(text).not.toContain("already running");
    expect(onStarted).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalledTimes(code === "build_already_in_progress" ? 1 : 0);
    expect(pop.getByText("Not published")).toBeTruthy();
    expect(pop.queryByText("Publishing…")).toBeNull();
    neverClaimsLive();

    const again = pop.getByRole("button", { name: "Publish" }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    fireEvent.click(again);
    await waitFor(() => expect(posts(SITE_PUBLISH)).toHaveLength(2));
    expect(posts("/api/website/publish")).toHaveLength(0);
  });

  it.each([
    ["a bare known code string", 403, { error: "forbidden" }, "Viewers can't publish. Ask a workspace owner, admin or member."],
    ["a bare unknown code string", 409, { error: "weird_internal_code" }, "We couldn't publish your site. Try again."],
    ["an error with no code", 403, { error: { message: "server words nobody should read" } }, "We couldn't publish your site. Try again."],
    ["a body that is not JSON", 502, null, "We couldn't publish your site. Try again."],
  ])("%s still gets a plain line and a usable Publish", async (_name, status, body, message) => {
    wireSitePublish(() =>
      body === null
        ? ({ ok: false, status, json: async () => { throw new Error("not json"); } } as unknown as Response)
        : refused(status, body),
    );
    const { pop, onStarted } = await sitePopover();
    fireEvent.click(pop.getByRole("button", { name: "Publish" }));
    expect((await pop.findByRole("alert")).textContent).toContain(message);
    const text = screen.getByTestId("popover").textContent ?? "";
    expect(text).not.toMatch(/weird_internal_code|server words|already running/);
    expect(onStarted).not.toHaveBeenCalled();
    expect((pop.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(false);
    neverClaimsLive();
  });

  it("already_published is not a failure: it reads live and up to date, re-reads the status, and shows no error", async () => {
    wireSitePublish(() =>
      refused(409, { error: { code: "already_published", message: "The latest version of this site is already published." } }),
    );
    const { pop, onStarted, onRefresh } = await sitePopover();
    fireEvent.click(pop.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(pop.getByRole("heading", { name: "Live" })).toBeTruthy();
    expect(pop.getByText("Your site is live and up to date.")).toBeTruthy();
    expect(pop.queryByRole("alert")).toBeNull();
    expect(pop.queryByText("Not published")).toBeNull();
    expect(pop.queryByText("Publishing…")).toBeNull();
    expect(screen.getByTestId("popover").textContent).not.toMatch(/already_published|couldn't publish|already running/);
    expect(onStarted).not.toHaveBeenCalled();
    const done = pop.getByRole("button", { name: "Up to date" }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.click(done);
    expect(posts(SITE_PUBLISH)).toHaveLength(1);
  });

  it("a network failure says the server was not reached and leaves Publish usable", async () => {
    wireSitePublish(() => {
      throw new Error("offline");
    });
    const { pop, onStarted } = await sitePopover();
    fireEvent.click(pop.getByRole("button", { name: "Publish" }));
    expect((await pop.findByRole("alert")).textContent).toContain("We couldn't reach the server. Try again.");
    expect(onStarted).not.toHaveBeenCalled();
    expect((pop.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(false);
    neverClaimsLive();
  });

  it("while publishing it shows progress and cannot start a second publish", async () => {
    wireSitePublish(() => ok({ ok: true }));
    const { pop } = await sitePopover({ status: "publishing" }, "publishing");
    expect(pop.getByRole("heading", { name: "Publishing…" })).toBeTruthy();
    expect(pop.getByText("Putting your site on its address. You can keep using the preview.")).toBeTruthy();
    const button = pop.getByRole("button", { name: "Publishing…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(posts(SITE_PUBLISH)).toHaveLength(0);
    neverClaimsLive();
  });

  it("a failed publish shows the reason and Try again starts one new publish", async () => {
    wireSitePublish(() => ok({ ok: true, conductor_run_id: "run-10" }));
    const { pop, onStarted } = await sitePopover(
      { status: "failed", reason: "The site's smoke check failed: login" },
      "failed",
    );
    expect(pop.getByText("Publishing didn't finish")).toBeTruthy();
    expect(pop.getByText("The site's smoke check failed: login")).toBeTruthy();
    expect(pop.queryByText("This site's last build didn't go live")).toBeNull();
    neverClaimsLive();
    fireEvent.click(pop.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    expect(posts(SITE_PUBLISH)).toHaveLength(1);
    expect(pop.getByRole("heading", { name: "Publishing…" })).toBeTruthy();
  });

  it("a publish the server never picked up stops spinning, says so, and Publish can be pressed again", async () => {
    wireSitePublish(() => ok({ ok: true, conductor_run_id: "run-9" }));
    const onStarted = vi.fn();
    const base = { siteId: "site-1", hostname: SITE_HOST, built: true, status: "none" as const, onStarted };
    const view = (late: boolean) => (
      <div data-testid="popover">
        <PublishPopover
          onGetDomain={() => {}}
          onClose={() => {}}
          appUrl="https://bakery-preview.e2b.app"
          appHost="bakery-preview.e2b.app"
          publishable={false}
          ownBuildApp
          site={{ liveUrl: null, status: "building" }}
          sitePublish={{ ...base, late }}
        />
      </div>
    );
    const r = render(view(false));
    await waitFor(() => expect(screen.queryByLabelText("Loading publish options")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Publishing…" })).toBeTruthy();
    r.rerender(view(true));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Publishing…" })).toBeNull());
    expect(screen.getByText("Your publish hasn't started yet. Press Publish to try again.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(posts(SITE_PUBLISH)).toHaveLength(2));
  });

  it("before the build is done Publish is off and says the site must be built first", async () => {
    wireSitePublish(() => ok({ ok: true }));
    const { pop } = await sitePopover({ built: false });
    expect(pop.getByText("Not published")).toBeTruthy();
    expect(pop.getByText("You can publish once your site is built.")).toBeTruthy();
    const button = pop.getByRole("button", { name: "Publish" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(posts(SITE_PUBLISH)).toHaveLength(0);
  });

  it("with the setting off the same site keeps today's popover and cannot reach the publish endpoint", async () => {
    wireSitePublish(() => ok({ ok: true }));
    const pop = await popover({
      appUrl: "https://bakery-preview.e2b.app",
      appHost: "bakery-preview.e2b.app",
      publishable: false,
      ownBuildApp: true,
      site: { liveUrl: null, status: "building" },
    });
    expect(pop.getByText("Not live yet")).toBeTruthy();
    expect(pop.queryByText("Not published")).toBeNull();
    expect(screen.getByTestId("popover").textContent).not.toContain(SITE_HOST);
    const button = pop.getByRole("button", { name: "Publish changes" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(posts(SITE_PUBLISH)).toHaveLength(0);
  });

  it("a live site's on-request popover reads Live, never Not published, and Publish changes starts one publish", async () => {
    wireSitePublish(() => ok({ ok: true, conductor_run_id: "run-11" }));
    const onStarted = vi.fn();
    const pop = await popover({
      appUrl: "https://bakery-preview.e2b.app",
      appHost: "bakery-preview.e2b.app",
      publishable: false,
      ownBuildApp: true,
      site: { liveUrl: `https://${SITE_HOST}`, status: "live" },
      sitePublish: { siteId: "site-1", hostname: SITE_HOST, built: true, status: "live", onStarted },
    });
    expect(pop.getByRole("heading", { name: "Live" })).toBeTruthy();
    expect(pop.queryByText("Not published")).toBeNull();
    expect(pop.queryByText("Publish to put your site on its address.")).toBeNull();
    expect(pop.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.getByTestId("popover").textContent).toContain(SITE_HOST);
    fireEvent.click(pop.getByRole("button", { name: "Publish changes" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    expect(posts(SITE_PUBLISH)).toHaveLength(1);
  });

  it("a first publish that went out but failed its check shows the reason and Try again, never Live or Not published", async () => {
    wireSitePublish(() => ok({ ok: true, conductor_run_id: "run-12" }));
    const reason = "The site was published but bakery-693dfbdb.zaviagent.com is not serving it yet.";
    const { pop, onStarted } = await sitePopover({ status: "failed", reason }, "building");
    expect(pop.getByRole("heading", { name: "Publishing didn't finish" })).toBeTruthy();
    expect(pop.getByText(reason)).toBeTruthy();
    expect(pop.queryByText("Not published")).toBeNull();
    neverClaimsLive();
    fireEvent.click(pop.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    expect(posts(SITE_PUBLISH)).toHaveLength(1);
  });

  it("a live site ignores the on-request state and behaves as it does today", async () => {
    wireSitePublish(() => ok({ ok: true }));
    const pop = await popover({
      appUrl: "https://bakery-preview.e2b.app",
      appHost: "bakery-preview.e2b.app",
      publishable: false,
      ownBuildApp: true,
      site: { liveUrl: "https://bakery.zaviagent.com", status: "live" },
      sitePublish: null,
    });
    expect(pop.getByText("Live")).toBeTruthy();
    expect(pop.getByLabelText("Copy link")).toBeTruthy();
    expect(posts(SITE_PUBLISH)).toHaveLength(0);
  });
});
