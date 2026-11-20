// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/components/ui/toast", () => ({ toast: { add: vi.fn(), update: vi.fn(), close: vi.fn() } }));

import { DomainsView } from "./WebsiteConsole";
import {
  BUILTIN_BLOCKED_TITLE,
  BUILTIN_POLL_MAX,
  BUILTIN_POLL_MS,
  BUILTIN_STUCK_TITLE,
  DNS_NOT_CONFIGURED_COPY,
  PublishPopover,
  builtinStuckCopy,
} from "./PublishPopover";
import { resetPublishReads } from "./publishReads";

const HOST = "apna-tutor-693dfbdb.zaviagent.com";
const URL_LIVE = `https://${HOST}`;

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function wire(builtinStatus: string | null, extra: Record<string, unknown> = {}) {
  apiFetch.mockImplementation(async (url: string) => {
    if (url === "/api/website/builtin-url")
      return ok({
        builtin: builtinStatus
          ? { label: "apna-tutor-693dfbdb", hostname: HOST, url: URL_LIVE, status: builtinStatus, dns_ready: true, ...extra }
          : null,
        base_domain: "zaviagent.com",
        custom_domain_attached: false,
      });
    if (url === "/api/website/custom-domains") return ok({ domains: [] });
    if (url === "/api/website/overview?app=workspace") return ok({ visibility: "public" });
    return ok({});
  });
}

function buildViewPopover(props: Partial<{ appUrl: string | null; appHost: string | null; publishable: boolean }> = {}) {
  return render(
    <div data-testid="popover">
      <PublishPopover
        appUrl={null}
        appHost={null}
        publishable={false}
        onGetDomain={() => {}}
        onClose={() => {}}
        {...props}
      />
    </div>,
  );
}

async function ready() {
  await waitFor(() => expect(screen.queryByLabelText("Loading publish options")).toBeNull());
}

afterEach(() => {
  cleanup();
  resetPublishReads();
  apiFetch.mockReset();
});

describe("Publish and Domains read the same live status (DEL-1323 B21)", () => {
  it("the ticket repro: a build view with no preview URL shows the live address Domains shows, not 'Not published'", async () => {
    wire("live");
    buildViewPopover();
    await ready();
    const pop = within(screen.getByTestId("popover"));
    expect(pop.getByText("Live")).toBeTruthy();
    expect(pop.queryByText("Not published")).toBeNull();
    expect(pop.queryByText("Build your app to get a live link")).toBeNull();
    expect(pop.queryByText("No live link yet")).toBeNull();
    expect(pop.getByTitle(URL_LIVE)).toBeTruthy();
    cleanup();
    wire("live");
    render(<DomainsView deployedUrl={null} />);
    await screen.findByText("Live");
    expect(screen.getAllByText(/apna-tutor-693dfbdb/).length).toBeGreaterThan(0);
  });

  it("the copy button hands the user the real live address", async () => {
    wire("live");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    buildViewPopover();
    await ready();
    fireEvent.click(screen.getByLabelText("Copy link"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_LIVE));
    const open = screen.queryByLabelText("More options");
    expect(open).toBeTruthy();
    fireEvent.click(open!);
    expect(screen.getByRole("menuitem", { name: /Open app/ }).getAttribute("href")).toBe(URL_LIVE);
  });

  it("never offers a first Publish or 'Build your app first' for a site that is already live", async () => {
    wire("live");
    buildViewPopover();
    await ready();
    expect(screen.queryByRole("button", { name: /^Publish$/ })).toBeNull();
    expect(screen.queryByTitle("Build your app first")).toBeNull();
  });

  it("a suspended address in a build view with no preview is Offline, never Live", async () => {
    wire("offline");
    buildViewPopover();
    await ready();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.queryByText("Live")).toBeNull();
    expect(screen.queryByLabelText("Copy link")).toBeNull();
  });

  it("no app and no live address still says Not published", async () => {
    wire(null);
    buildViewPopover();
    await ready();
    expect(screen.getByText("Not published")).toBeTruthy();
    expect(screen.getByText("No live link yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish" })).toHaveProperty("disabled", true);
  });

  it("an address still setting up with no app is not called Live", async () => {
    wire("verifying");
    buildViewPopover();
    await ready();
    expect(screen.queryByText("Live")).toBeNull();
    expect(screen.queryByLabelText("Copy link")).toBeNull();
  });

  it("an address the server cannot put live reads the same blocked state in Publish and Domains", async () => {
    wire("verifying", { dns_ready: false, setup_blocked: "dns_not_configured" });
    buildViewPopover();
    await ready();
    const pop = within(screen.getByTestId("popover"));
    expect(pop.getByText(BUILTIN_BLOCKED_TITLE)).toBeTruthy();
    expect(pop.getByText(DNS_NOT_CONFIGURED_COPY)).toBeTruthy();
    expect(pop.queryByText("Setting up your address")).toBeNull();
    expect(pop.queryByText("Not published")).toBeNull();
    expect(pop.queryByText("Live")).toBeNull();
    cleanup();
    wire("verifying", { dns_ready: false, setup_blocked: "dns_not_configured" });
    render(<DomainsView deployedUrl={null} />);
    await screen.findByText(BUILTIN_BLOCKED_TITLE);
    expect(screen.getByText(DNS_NOT_CONFIGURED_COPY)).toBeTruthy();
    expect(screen.queryByText("Setting up…")).toBeNull();
    expect(screen.queryByText(/it’ll be live in a moment/)).toBeNull();
  });

  it("an address that never finishes setting up stops saying 'Setting up' in both places once polling gives up", async () => {
    vi.useFakeTimers();
    try {
      wire("verifying");
      buildViewPopover();
      await vi.waitFor(() => expect(screen.queryByLabelText("Loading publish options")).toBeNull());
      const pop = within(screen.getByTestId("popover"));
      expect(pop.getByText("Setting up your address")).toBeTruthy();
      await vi.advanceTimersByTimeAsync(BUILTIN_POLL_MS * BUILTIN_POLL_MAX);
      await vi.waitFor(() => expect(pop.getByText(BUILTIN_STUCK_TITLE)).toBeTruthy());
      expect(pop.getByText(builtinStuckCopy(HOST))).toBeTruthy();
      expect(pop.queryByText("Setting up your address")).toBeNull();
      cleanup();
      apiFetch.mockReset();
      wire("verifying");
      render(<DomainsView deployedUrl={null} />);
      await vi.waitFor(() => expect(screen.getByText("Setting up…")).toBeTruthy());
      const gets = () => apiFetch.mock.calls.filter(([u, init]) => u === "/api/website/builtin-url" && !(init as RequestInit | undefined)?.method).length;
      await vi.advanceTimersByTimeAsync(4000 * 15);
      await vi.waitFor(() => expect(screen.getByText(BUILTIN_STUCK_TITLE)).toBeTruthy());
      expect(screen.getByText(builtinStuckCopy(HOST))).toBeTruthy();
      expect(screen.queryByText("Setting up…")).toBeNull();
      const atCap = gets();
      await vi.advanceTimersByTimeAsync(4000 * 3);
      expect(gets()).toBe(atCap);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a founder previewing their own registered site never reads the Zavi address", async () => {
    wire("offline");
    buildViewPopover({ appUrl: "https://their-own-site.com", appHost: "their-own-site.com" });
    await ready();
    expect(apiFetch.mock.calls.some(([u]) => u === "/api/website/builtin-url")).toBe(false);
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.queryByText("Offline")).toBeNull();
  });
});
