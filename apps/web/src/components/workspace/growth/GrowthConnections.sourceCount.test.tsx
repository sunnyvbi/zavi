// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GrowthConnections } from "./GrowthConnections";

const h = vi.hoisted(() => ({ connectors: [] as unknown[], oneState: true }));

vi.mock("../setup/SetupProvider", () => ({
  useSetupOptional: () => ({ state: { enabled: true, one_state: h.oneState ? true : undefined } }),
}));

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    const body: Record<string, unknown> = {
      "/api/connectors": { connectors: h.connectors },
      "/api/connectors/recommendations": { recommendations: [] },
      "/api/connectors/sync-status": { sources: {} },
    };
    return { ok: true, status: 200, json: async () => body[path] ?? {} } as unknown as Response;
  }),
}));
vi.mock("../settings/useSlackScopeStatus", () => ({
  useSlackScopeStatus: () => [],
  useSlackScopeState: () => ({ missing: [], settled: true }),
}));

afterEach(() => {
  cleanup();
  h.connectors = [];
  h.oneState = true;
});

const MANAGED_GITHUB = { slug: "github", account_login: "Praxis-build", connected_at: "2026-09-29T10:00:00Z" };

describe("B12: Your data never counts Zavi's own build repo as a source the founder connected", () => {
  it("a founder who connected nothing but has a Zavi-built site reads 0 sources, and the page footer hears 0", async () => {
    h.connectors = [MANAGED_GITHUB];
    const onHealth = vi.fn();
    render(<GrowthConnections anyMeasured={false} onHealth={onHealth} />);
    expect(await screen.findByText("0 sources connected")).toBeTruthy();
    expect(screen.queryByText(/1 source connected/)).toBeNull();
    expect(onHealth).toHaveBeenLastCalledWith({ connected: 0, notSyncing: 0 });
  });

  it("the managed row is skipped whatever its letter case", async () => {
    h.connectors = [{ ...MANAGED_GITHUB, account_login: "praxis-build" }];
    render(<GrowthConnections anyMeasured={false} />);
    expect(await screen.findByText("0 sources connected")).toBeTruthy();
  });

  it("the founder's own GitHub and other sources still count", async () => {
    h.connectors = [
      MANAGED_GITHUB,
      { slug: "stripe", connected_at: "2026-09-29T10:00:00Z" },
    ];
    render(<GrowthConnections anyMeasured={false} />);
    expect(await screen.findByText("1 source connected")).toBeTruthy();
    cleanup();
    h.connectors = [{ slug: "github", account_login: "acme-co", connected_at: "2026-09-29T10:00:00Z" }];
    render(<GrowthConnections anyMeasured={false} />);
    expect(await screen.findByText("1 source connected")).toBeTruthy();
  });
});

describe("B12 with setup_strategy_one_state off", () => {
  it("counts the managed build row as before", async () => {
    h.oneState = false;
    h.connectors = [MANAGED_GITHUB];
    render(<GrowthConnections anyMeasured={false} />);
    expect(await screen.findByText("1 source connected")).toBeTruthy();
    expect(screen.queryByText("0 sources connected")).toBeNull();
  });
});
