// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();

vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock("../../WorkspaceShell", () => ({
  useWorkspace: () => ({
    userEmail: "ravi@upcar.ai",
    tenantName: "UpcarAI",
    openTab: () => {},
    creditsRemaining: 100,
  }),
}));
vi.mock("./HomeChatPanel", () => ({ HomeChatPanel: () => null }));
vi.mock("./AddGoalModal", () => ({ AddGoalModal: () => null }));
vi.mock("../BuilderChatCard", () => ({ BuilderChatCard: () => null }));
vi.mock("./NeedsYouNow", () => ({
  NeedsYouNow: () => <div data-testid="needs-you" />,
}));
vi.mock("./GoalsSection", () => ({
  GoalsSection: () => <div data-testid="goals" />,
}));
vi.mock("./BusinessStatsRow", () => ({
  BusinessStatsRow: () => <div data-testid="stats" />,
}));
vi.mock("./SetupStrip", () => ({
  SetupStrip: () => <div data-testid="setup-strip" />,
}));
vi.mock("../../GettingStartedCard", () => ({
  BrainSetupPanel: () => <div data-testid="brain-panel" />,
  OnboardingMemoryBanner: () => null,
}));

import { CalmHome } from "./CalmHome";

type Deferred = {
  resolve: (v: unknown) => void;
  promise: Promise<unknown>;
};
function deferred(): Deferred {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

let summaryReq: Deferred;
let activationReq: Deferred;

beforeEach(() => {
  summaryReq = deferred();
  activationReq = deferred();
  apiFetch.mockReset();
  apiFetch.mockImplementation((url: string) => {
    if (url === "/api/home/summary") return summaryReq.promise;
    if (url === "/api/workspace/activation") return activationReq.promise;
    return Promise.resolve(okJson({}));
  });
});

afterEach(cleanup);

describe("CalmHome — initial-load skeleton gating", () => {
  it("shows the skeleton while both reads are pending, and holds it until activation settles too", async () => {
    render(<CalmHome />);

    expect(screen.getByText("Loading your home…")).toBeTruthy();
    expect(screen.queryByTestId("setup-strip")).toBeNull();
    expect(screen.queryByTestId("needs-you")).toBeNull();

    summaryReq.resolve(
      okJson({ active_runs_today: [], pending_approvals_count: 0 }),
    );
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/home/summary"));
    expect(screen.getByText("Loading your home…")).toBeTruthy();
    expect(screen.queryByTestId("setup-strip")).toBeNull();

    activationReq.resolve(okJson({ brain: null, connectors_count: 2 }));
    await waitFor(() => expect(screen.queryByText("Loading your home…")).toBeNull());
    expect(screen.getByTestId("setup-strip")).toBeTruthy();
    expect(screen.getByTestId("needs-you")).toBeTruthy();
    expect(screen.getByTestId("goals")).toBeTruthy();
  });

  it("clears the skeleton even when the activation read fails (bounded gate)", async () => {
    render(<CalmHome />);
    summaryReq.resolve(
      okJson({ active_runs_today: [], pending_approvals_count: 0 }),
    );
    activationReq.resolve({ ok: false, status: 500, json: async () => ({}) });
    await waitFor(() => expect(screen.queryByText("Loading your home…")).toBeNull());
    expect(screen.getByTestId("setup-strip")).toBeTruthy();
  });
});
