// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";

type Reply = { status: number; body: unknown };
const net = vi.hoisted(() => ({
  pending: new Map<string, Array<(r: Reply) => void>>(),
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => {
    const key = path.split("?")[0]!;
    return new Promise((resolve) => {
      const queue = net.pending.get(key) ?? [];
      queue.push((r: Reply) =>
        resolve({
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          json: async () => r.body,
        }),
      );
      net.pending.set(key, queue);
    });
  },
  apiUrl: (path: string) => path,
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

import { BuildTranscript } from "./BuildModePane";
import { BUILD_CHECKS_FAILED, BUILD_FIXES_EXHAUSTED, SITE_DATABASE_SLOW } from "@zavi/shared";

let seq = 0;
let SESSION = "e1a0c3d2-0000-4000-8000-000000000000";
const STATUS = "/api/workspace/autopilot/build-status";
const REFINES = "/api/workspace/autopilot/refines";
const LIVE = "https://paws-and-suds-1a2b3c.zaviagent.com/";
const ADMIN = "https://paws-and-suds-1a2b3c.zaviagent.com/admin";
const FIXING = "Publishing stopped: the final check failed, we're fixing it.";
const STOPPED = "Publishing stopped: the final check failed.";
const READY = "Your preview is ready. Publishing runs a final check, then puts it live.";

const SITE_STAGES = [
  { stage: "provision", status: "done", finished_at: "2026-10-05T05:31:00.000Z" },
  { stage: "build", status: "done", finished_at: "2026-10-05T05:39:00.000Z" },
];

const run = () => ({
  id: SESSION,
  objective: "Build product: Paws & Suds, dog grooming bookings",
  status: "done",
  created_at: "2026-10-05T05:30:00.000Z",
  updated_at: "2026-10-05T05:39:00.000Z",
  stages: SITE_STAGES,
});

const unpublished = (publish: Record<string, unknown>) => ({
  run: run(),
  target: { live_url: null },
  app_ready: true,
  publish,
});

const published = (publish: Record<string, unknown> = { status: "live", started_at: null, url: LIVE, retryable: false }) => ({
  run: run(),
  target: { live_url: LIVE, admin_url: ADMIN, admin_setup_email: "owner@paws.test", live_announce: true },
  app_ready: false,
  publish,
});

const NONE = { status: "none", started_at: null, url: null, retryable: false };
const FIX_PASS = {
  status: "publishing",
  started_at: "2026-10-05T05:48:00.000Z",
  url: null,
  retryable: false,
  fixing: true,
  reason: "The site's smoke check failed: journey \"open-times\" failed",
};
const failedWith = (reason: string) => ({
  status: "failed",
  started_at: "2026-10-05T05:48:00.000Z",
  url: null,
  retryable: false,
  reason,
});

async function reply(path: string, r: Reply) {
  await waitFor(() => expect(net.pending.get(path)?.length ?? 0).toBeGreaterThan(0));
  const next = net.pending.get(path)!.shift()!;
  await act(async () => {
    next(r);
  });
}

async function mount(body: unknown) {
  render(<BuildTranscript sessionId={SESSION} publishOnRequest />);
  await reply(STATUS, { status: 200, body });
  await reply(REFINES, { status: 200, body: { refines: [] } });
}

beforeEach(() => {
  seq += 1;
  SESSION = `e1a0c3d2-0000-4000-8000-${String(seq).padStart(12, "0")}`;
});

afterEach(() => {
  cleanup();
  net.pending.clear();
  window.localStorage.clear();
});

describe("l2.3 + l2.4: the build card before, during and after publish", () => {
  it("before publish the card says the preview is ready and that publishing runs a final check, with no live link or admin", async () => {
    await mount(unpublished(NONE));
    expect(screen.getByTestId("build-publish-on-request").textContent).toBe(READY);
    expect(document.body.textContent).not.toContain("Press Publish to put it on its address");
    expect(screen.queryByTestId("build-open-site")).toBeNull();
    expect(screen.queryByTestId("build-open-admin")).toBeNull();
    expect(document.body.textContent).not.toMatch(/final check failed|is live/);
  });

  it("a publish whose final check failed says so while the fix runs, never the raw signal, then goes live with the address, Open admin and login hint", async () => {
    await mount(unpublished(FIX_PASS));
    const state = screen.getByTestId("build-publish-state");
    expect(state.textContent).toBe(FIXING);
    expect(state.getAttribute("role")).toBe("status");
    expect(document.body.textContent).not.toContain("smoke check");
    expect(document.body.textContent).not.toContain("open-times");
    expect(document.body.textContent).not.toContain("didn't finish");
    expect(screen.queryByTestId("build-publish-on-request")).toBeNull();

    await reply(STATUS, { status: 200, body: published() });

    await waitFor(() => expect(screen.getByTestId("build-open-site").getAttribute("href")).toBe(LIVE));
    expect(document.body.textContent).not.toContain("final check failed");
    expect(screen.queryByTestId("build-publish-state")).toBeNull();
    expect(screen.queryByTestId("build-publish-on-request")).toBeNull();
    expect(screen.getByTestId("build-open-admin").getAttribute("href")).toBe(`${ADMIN}?from=zavi`);
    const login = screen.getAllByTestId("build-admin-login");
    expect(login).toHaveLength(1);
    expect(login[0]!.textContent).toContain(`Log in to your admin at ${ADMIN}?from=zavi.`);
    expect(login[0]!.textContent).toContain("We emailed a one-click login link to owner@paws.test.");
  });

  it("when the fixes run out the card says publishing stopped on the final check, does not claim it is still being fixed, and points back to Publish", async () => {
    await mount(unpublished(FIX_PASS));
    expect(screen.getByTestId("build-publish-state").textContent).toBe(FIXING);

    await reply(STATUS, { status: 200, body: unpublished(failedWith(BUILD_FIXES_EXHAUSTED)) });

    await waitFor(() =>
      expect(screen.getByTestId("build-publish-state").textContent).toBe(`${STOPPED} ${BUILD_FIXES_EXHAUSTED} Press Publish to try again.`),
    );
    const state = screen.getByTestId("build-publish-state");
    expect(state.getAttribute("role")).toBe("alert");
    expect(state.textContent).not.toContain("we're fixing it");
    expect(screen.queryByTestId("build-open-site")).toBeNull();
    expect(screen.queryByTestId("build-open-admin")).toBeNull();
  });

  it("a held-back app (checks failed) also reads as the final check", async () => {
    await mount(unpublished(failedWith(BUILD_CHECKS_FAILED)));
    expect(screen.getByTestId("build-publish-state").textContent).toBe(`${STOPPED} ${BUILD_CHECKS_FAILED} Press Publish to try again.`);
  });

  it("a publish that stopped for another reason never blames the final check", async () => {
    await mount(unpublished(failedWith(SITE_DATABASE_SLOW)));
    const state = screen.getByTestId("build-publish-state");
    expect(state.textContent).toContain("Publishing to your address didn't finish.");
    expect(state.textContent).toContain(SITE_DATABASE_SLOW);
    expect(state.textContent).not.toContain("final check");
    expect(screen.getByTestId("build-done-badge").textContent).toBe("Publish stopped");
  });

  it("the card's pill follows the publish: Ready before, Publish stopped on a stop, Live once it is up", async () => {
    await mount(unpublished(NONE));
    expect(screen.getByTestId("build-done-badge").textContent).toBe("Ready");
    await reply(STATUS, { status: 200, body: unpublished(failedWith(BUILD_FIXES_EXHAUSTED)) });
    await waitFor(() => expect(screen.getByTestId("build-done-badge").textContent).toBe("Publish stopped"));
    expect(screen.getByTestId("build-done-badge").querySelector(".bg-ca-danger")).not.toBeNull();
    await reply(STATUS, { status: 200, body: published() });
    await waitFor(() => expect(screen.getByTestId("build-done-badge").textContent).toBe("Live"));
    expect(screen.getByTestId("build-done-badge").querySelector(".bg-ca-danger")).toBeNull();
  });

  it("the pill never says a flat grey Ready while the address is still publishing", async () => {
    await mount(unpublished({ status: "publishing", started_at: null, url: null, retryable: false }));
    const pill = screen.getByTestId("build-done-badge");
    expect(pill.textContent).toBe("Publishing");
    expect(pill.getAttribute("data-state")).toBe("publishing");
    expect(pill.querySelector(".animate-spin")).not.toBeNull();
    expect(pill.querySelector(".bg-ca-strong")).toBeNull();
    expect(screen.getByTestId("build-done-icon").getAttribute("data-state")).toBe("done");
    await reply(STATUS, { status: 200, body: unpublished(NONE) });
    await waitFor(() => expect(screen.getByTestId("build-done-badge").textContent).toBe("Ready"));
    const ready = screen.getByTestId("build-done-badge");
    expect(ready.querySelector(".bg-ca-success")).not.toBeNull();
    expect(ready.querySelector(".bg-ca-strong, .animate-spin")).toBeNull();
    await reply(STATUS, { status: 200, body: unpublished(failedWith(BUILD_FIXES_EXHAUSTED)) });
    await waitFor(() => expect(screen.getByTestId("build-done-icon").getAttribute("data-state")).toBe("stopped"));
    expect(screen.getByTestId("build-done-icon").className).toContain("text-ca-danger");
  });

  it("a publish that goes live with a stale fix reason in its payload shows only the live card", async () => {
    await mount(published({ status: "live", started_at: null, url: LIVE, retryable: false, fixing: true, reason: BUILD_FIXES_EXHAUSTED }));
    const card = screen.getByTestId("build-live-announce");
    expect(within(card).getByTestId("build-open-admin").getAttribute("href")).toBe(`${ADMIN}?from=zavi`);
    expect(document.body.textContent).not.toContain("final check");
    expect(document.body.textContent).not.toContain(BUILD_FIXES_EXHAUSTED);
  });
});
