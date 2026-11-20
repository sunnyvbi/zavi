// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

type Reply = { status: number; body: unknown };
const net = vi.hoisted(() => ({
  pending: new Map<string, Array<((r: Reply) => void) & { url?: string }>>(),
  toasts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => {
    const key = path.split("?")[0]!;
    return new Promise((resolve) => {
      const queue = net.pending.get(key) ?? [];
      const answer = Object.assign(
        (r: Reply) =>
          resolve({
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            json: async () => r.body,
          }),
        { url: path },
      );
      queue.push(answer);
      net.pending.set(key, queue);
    });
  },
}));
const setupMock = vi.hoisted(() => ({ value: null as { locked: boolean; state?: unknown } | null, openStatic: vi.fn() }));
vi.mock("../WorkspaceShell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../WorkspaceShell")>()),
  useWorkspace: () => ({ treeAgents: [], supplyDemandEligible: false }),
}));
vi.mock("../setup/SetupProvider", () => ({ useSetupOptional: () => setupMock.value }));
vi.mock("../layout/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../layout/shared")>()),
  useOpenStatic: () => setupMock.openStatic,
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  notifyBuildSessionsChanged: () => {},
}));
vi.mock("@/lib/workspace/useBuildPreview", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/workspace/useBuildPreview")>();
  return {
    ...real,
    pollDelayMs: () => 5,
    sharedBuildRead: (path: string) => real.sharedBuildRead(path, { fresh: true }),
  };
});
vi.mock("@/components/ui/toast", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/ui/toast")>();
  return {
    ...real,
    toast: {
      ...real.toast,
      add: (opts: Record<string, unknown>) => {
        net.toasts.push(opts);
        return "t";
      },
    },
  };
});

import { BuildTranscript } from "./BuildModePane";

let sessionSeq = 0;
let SESSION = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const STATUS = "/api/workspace/autopilot/build-status";
const REFINES = "/api/workspace/autopilot/refines";
const LIVE = "https://apna-tutor-693dfbdb.zaviagent.com/";
const ADMIN = "https://apna-tutor-693dfbdb.zaviagent.com/admin";

const run = (status: string) => ({
  id: SESSION,
  objective: "Build product: Paws & Suds — dog grooming bookings",
  status,
  created_at: "2026-09-29T06:55:00.000Z",
  updated_at: "2026-09-29T07:10:00.000Z",
  stages: [],
});

async function reply(path: string, r: Reply, forRun?: string) {
  const matches = (url?: string) => !forRun || (url ?? "").includes(encodeURIComponent(forRun));
  await waitFor(() =>
    expect((net.pending.get(path) ?? []).some((a) => matches(a.url))).toBe(true),
  );
  const queue = net.pending.get(path)!;
  const next = queue.splice(queue.findIndex((a) => matches(a.url)), 1)[0]!;
  await act(async () => {
    next(r);
  });
}

async function mount(status: string, target: Record<string, unknown>) {
  render(<BuildTranscript sessionId={SESSION} />);
  await reply(STATUS, { status: 200, body: { run: run(status), target } });
  await reply(REFINES, { status: 200, body: { refines: [] } });
}

const liveTarget = { live_url: LIVE, admin_url: ADMIN, live_announce: true };

beforeEach(() => {
  sessionSeq += 1;
  SESSION = `d130919a-bec1-48bc-9dbf-${String(sessionSeq).padStart(12, "0")}`;
});

afterEach(() => {
  cleanup();
  net.pending.clear();
  net.toasts.length = 0;
  window.localStorage.clear();
  setupMock.value = null;
});

describe("Build live moment (DEL-1323 B20, Q12)", () => {
  it("watching a build go live: one toast with the address, and the card carries the live link and Open admin", async () => {
    await mount("active", { live_url: null });
    expect(screen.queryByTestId("build-live-announce")).toBeNull();
    expect(net.toasts).toEqual([]);

    await reply(STATUS, { status: 200, body: { run: run("done"), target: liveTarget } });

    await waitFor(() => expect(net.toasts).toHaveLength(1));
    expect(net.toasts[0]).toMatchObject({
      type: "success",
      title: "Your site is live",
      description: LIVE,
    });
    const action = net.toasts[0]!.actionProps as { children: string; onClick: () => void };
    expect(action.children).toBe("Open site");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    action.onClick();
    expect(open).toHaveBeenCalledWith(LIVE, "_blank", "noopener,noreferrer");
    open.mockRestore();

    screen.getByRole("button", { name: /Your site is live/ });
    expect(screen.queryByTestId("build-live-url")).toBeNull();
    expect(screen.getByTestId("build-live-announce").textContent).toContain(
      "Try it as a visitor, then open your admin to see what comes in.",
    );
    const openSite = screen.getByTestId("build-open-site");
    expect(openSite.getAttribute("href")).toBe(LIVE);
    expect(openSite.getAttribute("rel")).toContain("noopener");
    expect(screen.getByTestId("build-open-admin").getAttribute("href")).toBe(`${ADMIN}?from=zavi`);
    expect(screen.getAllByTestId("build-admin-login")).toHaveLength(1);
    expect(document.body.textContent?.split("Log in to your admin at").length).toBe(2);

    await reply(STATUS, { status: 200, body: { run: run("done"), target: liveTarget } });
    await reply(STATUS, { status: 200, body: { run: run("done"), target: liveTarget } });
    expect(net.toasts).toHaveLength(1);
  });

  it("announces the branded address when the server sends one, not the Render host", async () => {
    const BRANDED = "https://paws-suds.zaviagent.com/";
    await mount("active", { live_url: null });
    await reply(STATUS, {
      status: 200,
      body: {
        run: run("done"),
        target: { live_url: "https://paws-suds.onrender.com/", live_announce: true, live_announce_url: BRANDED },
      },
    });
    await waitFor(() => expect(net.toasts).toHaveLength(1));
    expect(net.toasts[0]).toMatchObject({ description: BRANDED });
    expect(screen.getByTestId("build-open-site").getAttribute("href")).toBe(BRANDED);
    expect(screen.getByTestId("build-open-site").getAttribute("href")).toBe(BRANDED);
    expect(document.querySelector('a[href*="onrender.com"]')).toBeNull();
  });

  it("switching to another build while the first is live still toasts the second build's own go-live", async () => {
    const A = SESSION;
    const B = `${SESSION.slice(0, -4)}bbbb`;
    const B_LIVE = "https://second-build.zaviagent.com/";
    const runFor = (id: string, status: string) => ({ ...run(status), id });
    const view = render(<BuildTranscript sessionId={A} />);
    await reply(STATUS, { status: 200, body: { run: runFor(A, "active"), target: { live_url: null } } });
    await reply(REFINES, { status: 200, body: { refines: [] } });
    await reply(STATUS, { status: 200, body: { run: runFor(A, "done"), target: liveTarget } });
    await waitFor(() => expect(net.toasts).toHaveLength(1));
    expect(net.toasts[0]).toMatchObject({ description: LIVE });

    view.rerender(<BuildTranscript sessionId={B} />);
    await reply(STATUS, { status: 200, body: { run: runFor(B, "active"), target: { live_url: null } } }, B);
    await reply(REFINES, { status: 200, body: { refines: [] } });
    expect(window.localStorage.getItem(`zavi.build.liveAnnounced.${B}`)).toBeNull();
    await reply(
      STATUS,
      {
        status: 200,
        body: { run: runFor(B, "done"), target: { live_url: B_LIVE, live_announce: true } },
      },
      B,
    );

    await waitFor(() => expect(net.toasts).toHaveLength(2));
    expect(net.toasts[1]).toMatchObject({ title: "Your site is live", description: B_LIVE });
    expect(screen.getByTestId("build-open-site").getAttribute("href")).toBe(B_LIVE);
  });

  it("a live address that blips to null and back never toasts twice", async () => {
    await mount("active", { live_url: null });
    await reply(STATUS, { status: 200, body: { run: run("done"), target: liveTarget } });
    await waitFor(() => expect(net.toasts).toHaveLength(1));
    await reply(STATUS, { status: 200, body: { run: run("done"), target: { live_url: null } } });
    await waitFor(() => expect(screen.queryByTestId("build-live-announce")).toBeNull());
    await reply(STATUS, { status: 200, body: { run: run("done"), target: liveTarget } });
    await waitFor(() => screen.getByTestId("build-live-announce"));
    expect(net.toasts).toHaveLength(1);
  });

  it("a build already announced in this browser does not toast again after a reload", async () => {
    await mount("active", { live_url: null });
    await reply(STATUS, { status: 200, body: { run: run("done"), target: liveTarget } });
    await waitFor(() => expect(net.toasts).toHaveLength(1));
    cleanup();
    net.pending.clear();
    await mount("active", { live_url: null });
    await reply(STATUS, { status: 200, body: { run: run("done"), target: liveTarget } });
    await waitFor(() => screen.getByTestId("build-live-announce"));
    expect(net.toasts).toHaveLength(1);
  });

  it("a blocked localStorage still toasts once", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await mount("active", { live_url: null });
    await reply(STATUS, { status: 200, body: { run: run("done"), target: liveTarget } });
    await waitFor(() => expect(net.toasts).toHaveLength(1));
    get.mockRestore();
    set.mockRestore();
  });

  it("opening a build that is already live shows the live card but never toasts", async () => {
    await mount("done", liveTarget);
    screen.getByRole("button", { name: /Your site is live/ });
    expect(screen.getByTestId("build-open-site").getAttribute("href")).toBe(LIVE);
    expect(screen.getByTestId("build-done-badge").textContent).toBe("Live");
    expect(screen.getByTestId("build-done-badge").querySelector(".bg-ca-success")).not.toBeNull();
    await reply(STATUS, { status: 200, body: { run: run("done"), target: liveTarget } });
    expect(net.toasts).toEqual([]);
  });

  it("the live card says the owner was emailed a one-click login link, once", async () => {
    await mount("done", { ...liveTarget, admin_setup_email: "owner@zavi.co" });
    screen.getByRole("button", { name: /Your site is live/ });
    const lines = screen.getAllByTestId("build-admin-login");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toBe(
      `Log in to your admin at ${ADMIN}?from=zavi. We emailed a one-click login link to owner@zavi.co. Your Zavi password does not work there. Sign in with an email link first.`,
    );
    expect(screen.getByTestId("build-open-admin").getAttribute("href")).toBe(`${ADMIN}?from=zavi`);
    expect(document.body.textContent).not.toMatch(/setup link|sign up with/);
    expect(screen.getAllByRole("button", { name: "Email me a new login link" })).toHaveLength(1);
  });

  it("a live site with no admin page gets Open site but no Open admin", async () => {
    await mount("done", { live_url: LIVE, admin_url: null, live_announce: true });
    screen.getByTestId("build-open-site");
    expect(screen.queryByTestId("build-open-admin")).toBeNull();
    expect(screen.getByTestId("build-live-announce").textContent).toContain("Try it as a visitor.");
    expect(screen.getByTestId("build-live-announce").textContent).not.toContain("admin");
  });

  it("a site that goes offline instead of live is never announced", async () => {
    await mount("active", { live_url: null });
    await reply(STATUS, {
      status: 200,
      body: { run: run("done"), target: { live_url: null, site_offline: true, live_announce: true } },
    });
    await waitFor(() => screen.getByTestId("build-site-offline"));
    expect(screen.queryByTestId("build-live-announce")).toBeNull();
    expect(net.toasts).toEqual([]);
  });

  it("a non-http live address is never linked or toasted", async () => {
    await mount("active", { live_url: null });
    await reply(STATUS, {
      status: 200,
      body: { run: run("done"), target: { live_url: "javascript:alert(1)", live_announce: true } },
    });
    await waitFor(() => screen.getByRole("button", { name: /Your app is ready/ }));
    expect(screen.queryByTestId("build-live-announce")).toBeNull();
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
    expect(net.toasts).toEqual([]);
  });

  it("key off: the old 'Your app is ready' card, no live link, no toast", async () => {
    await mount("active", { live_url: null });
    await reply(STATUS, {
      status: 200,
      body: { run: run("done"), target: { live_url: LIVE, admin_url: ADMIN } },
    });
    await waitFor(() => screen.getByRole("button", { name: /Your app is ready/ }));
    expect(screen.queryByTestId("build-live-announce")).toBeNull();
    expect(screen.queryByTestId("build-open-admin")).toBeNull();
    screen.getByTestId("build-admin-login");
    expect(net.toasts).toEqual([]);
  });

  it("no growth strategy next-step card under a live or ready build, even before the strategy exists", async () => {
    setupMock.value = { locked: true, state: { enabled: true, done: false } };
    await mount("done", liveTarget);
    await screen.findByTestId("build-live-announce");
    expect(screen.queryByTestId("growth-handoff")).toBeNull();
    expect(document.body.textContent).not.toContain("Build my growth strategy");
    expect(document.body.textContent).not.toContain("Don't skip the next step");
  });

  it("UI A: no next-step card once a growth strategy exists", async () => {
    setupMock.value = { locked: false, state: { enabled: true, done: true } };
    await mount("done", liveTarget);
    await screen.findByTestId("build-live-announce");
    expect(screen.queryByTestId("growth-handoff")).toBeNull();
  });
});
