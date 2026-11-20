// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
let role = "owner";
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ role, openTab: vi.fn() }),
}));

import { WebsiteConsole, __resetAppCatalogInflight } from "./WebsiteConsole";

const RUN_A = "aaaaaaaa-1111-4000-8000-00000000000a";
const RUN_B = "bbbbbbbb-1111-4000-8000-00000000000b";
const RUN_OLD = "cccccccc-1111-4000-8000-00000000000c";
const HOST_A = "lotus-pilates-1a2b3c4d-9f8e7d.zaviagent.com";
const HOST_B = "paws-corner-1a2b3c4d-0a0b0c.zaviagent.com";
const LIVE_A = "https://lotus-pilates-live.zaviagent.com";

type Overview = {
  app: { name: string; description: null; created_at: string; deployed_url: string | null; build_status: string };
  visibility: null;
  badge_hidden: null;
  site: { id: string; hostname: string; status: string };
};

const siteOverview = (name: string, host: string, status: string, deployed: string | null): Overview => ({
  app: { name, description: null, created_at: "2026-10-05T00:00:00Z", deployed_url: deployed, build_status: "done" },
  visibility: null,
  badge_hidden: null,
  site: { id: `site-${name}`, hostname: host, status },
});

type Deferred = { resolve: () => void; promise: Promise<void> };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { resolve, promise };
};

let overviews: Record<string, Overview>;
let gates: Record<string, Deferred | undefined>;

function wire() {
  apiFetch.mockImplementation(async (url: string) => {
    for (const run of Object.keys(overviews)) {
      if (url.includes(`build_session_id=${run}`)) {
        const gate = gates[run];
        if (gate) await gate.promise;
        return { ok: true, status: 200, json: async () => overviews[run] };
      }
    }
    if (url.includes("/api/website/builtin-url") || url.includes("/api/website/custom-domains")) {
      return { ok: false, status: 409, json: async () => ({ error: { code: "no_deployed_app" } }) };
    }
    if (url.includes("/api/website/app-catalog")) {
      return { ok: true, status: 200, json: async () => ({ connected: true, supported: true, dialect: "postgres", can_write: true, tables: [] }) };
    }
    if (url.includes("/api/website/app-invites")) {
      return { ok: true, status: 200, json: async () => ({ connected: true, signup_available: true, invites: [] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        app: { name: "Old App", description: null, created_at: null, deployed_url: "https://old.test", build_status: "done" },
        visibility: "public",
        badge_hidden: false,
      }),
    };
  });
}

const called = () => apiFetch.mock.calls.map((c) => String(c[0]));
const nav = () => document.querySelector("nav") as HTMLElement;
const navButton = (label: string) =>
  Array.from(nav().querySelectorAll("button")).find((b) => b.textContent?.trim() === label) ?? null;
const sectionParam = () => new URLSearchParams(window.location.search).get("section");

let writeText: Mock<[string], Promise<void>>;

beforeEach(() => {
  role = "owner";
  window.history.replaceState(null, "", "/workspace");
  apiFetch.mockReset();
  __resetAppCatalogInflight();
  overviews = {
    [RUN_A]: siteOverview("Lotus Pilates", HOST_A, "live", LIVE_A),
    [RUN_B]: siteOverview("Paws Corner", HOST_B, "live", `https://${HOST_B}`),
  };
  gates = {};
  wire();
  writeText = vi.fn((_text: string) => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => cleanup());

describe("a new-flow site's Domains section", () => {
  it("the Publish 'Get domain' jump on a cold mount lands on Domains even when the overview answers after the jump", async () => {
    gates[RUN_A] = deferred();
    render(<WebsiteConsole buildSessionId={RUN_A} navSignal={{ section: "domains", nonce: 1 }} />);
    await act(async () => {
      gates[RUN_A]!.resolve();
    });

    expect(await screen.findByRole("heading", { name: "Domains" })).toBeTruthy();
    expect(screen.getByTestId("site-address").textContent).toBe("lotus-pilates-live.zaviagent.com");
    expect(screen.getByText("Custom domains are coming soon")).toBeTruthy();
    expect(navButton("Domains")?.getAttribute("aria-current")).toBe("page");
    expect(navButton("Overview")?.getAttribute("aria-current")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Lotus Pilates" })).toBeNull();
    expect(sectionParam()).toBe("domains");
    expect(called().some((u) => /builtin-url|custom-domains|app-catalog|app-rows|app-invites/.test(u))).toBe(false);
  });

  it("an already-open site console switches from Overview to Domains on a re-fired jump", async () => {
    const { rerender } = render(<WebsiteConsole buildSessionId={RUN_A} navSignal={null} />);
    expect(await screen.findByRole("heading", { name: "Lotus Pilates" })).toBeTruthy();
    rerender(<WebsiteConsole buildSessionId={RUN_A} navSignal={{ section: "domains", nonce: 7 }} />);
    expect(await screen.findByRole("heading", { name: "Domains" })).toBeTruthy();
    expect(sectionParam()).toBe("domains");
  });

  it("a reload on ?section=domains keeps a site on Domains instead of bouncing to Overview", async () => {
    window.history.replaceState(null, "", "/workspace?section=domains");
    render(<WebsiteConsole buildSessionId={RUN_A} />);
    expect(await screen.findByRole("heading", { name: "Domains" })).toBeTruthy();
    await waitFor(() => expect(sectionParam()).toBe("domains"));
  });

  it("copies and opens the live address the server reported, not one rebuilt from the hostname", async () => {
    render(<WebsiteConsole buildSessionId={RUN_A} navSignal={{ section: "domains", nonce: 1 }} />);
    await screen.findByRole("heading", { name: "Domains" });

    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(LIVE_A);
    expect((await screen.findByRole("button", { name: "Copied address" })).textContent).toBe("");

    const open = screen.getByRole("link", { name: "Open site" }) as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe(LIVE_A);
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toContain("noopener");
  });

  it("an unpublished site shows the address it will have, says it is not live, and offers no Open link", async () => {
    overviews[RUN_A] = siteOverview("Lotus Pilates", HOST_A, "building", null);
    render(<WebsiteConsole buildSessionId={RUN_A} navSignal={{ section: "domains", nonce: 1 }} />);
    await screen.findByRole("heading", { name: "Domains" });

    expect(screen.getByTestId("site-address").textContent).toBe(HOST_A);
    expect(screen.getByText(/Not live yet/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open site" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`https://${HOST_A}`));
  });

  it("a site being deleted shows no address to copy or open", async () => {
    overviews[RUN_A] = siteOverview("Lotus Pilates", HOST_A, "deleting", null);
    render(<WebsiteConsole buildSessionId={RUN_A} navSignal={{ section: "domains", nonce: 1 }} />);
    await screen.findByRole("heading", { name: "Domains" });

    expect(screen.getByText("This site is no longer published.")).toBeTruthy();
    expect(screen.queryByTestId("site-address")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy address" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open site" })).toBeNull();
  });

  it("a member who cannot manage server functions still sees Domains", async () => {
    role = "member";
    render(<WebsiteConsole buildSessionId={RUN_A} />);
    await screen.findByRole("heading", { name: "Lotus Pilates" });
    expect(navButton("Domains")).toBeTruthy();
    expect(navButton("Secrets")).toBeNull();
    expect(nav().textContent).not.toMatch(/Users|Data/);
    fireEvent.click(navButton("Domains")!);
    expect(await screen.findByTestId("site-address")).toBeTruthy();
  });

  it("switching sites while Domains is open never shows the previous site's address, even when its read lands late", async () => {
    gates[RUN_A] = deferred();
    gates[RUN_B] = deferred();
    const { rerender } = render(<WebsiteConsole buildSessionId={RUN_A} navSignal={{ section: "domains", nonce: 1 }} />);
    rerender(<WebsiteConsole buildSessionId={RUN_B} navSignal={{ section: "domains", nonce: 1 }} />);

    await act(async () => {
      gates[RUN_B]!.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("site-address").textContent).toBe(HOST_B));
    await act(async () => {
      gates[RUN_A]!.resolve();
    });
    expect(screen.getByTestId("site-address").textContent).toBe(HOST_B);
    expect(screen.queryByText(/lotus-pilates/)).toBeNull();
  });

  it("the old workspace app keeps its own Domains screen with custom-domain management", async () => {
    render(<WebsiteConsole buildSessionId={RUN_OLD} navSignal={{ section: "domains", nonce: 1 }} />);
    expect(await screen.findByRole("heading", { name: "Domains" })).toBeTruthy();
    expect(screen.queryByText("Custom domains are coming soon")).toBeNull();
    await waitFor(() => expect(called().some((u) => u.includes("/api/website/custom-domains"))).toBe(true));
  });
});
