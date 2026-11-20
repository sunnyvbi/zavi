// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ planLoading: true, strategyLoading: true }));

vi.mock("@/lib/workspace/useGrowthPlan", () => ({
  useGrowthPlan: () => ({
    data: null,
    loading: h.planLoading,
    error: null,
    reload: vi.fn(),
    refresh: vi.fn(),
    drafting: false,
    draftSlow: false,
    watchForPlan: vi.fn(),
  }),
}));
vi.mock("@/lib/workspace/useGrowthStrategy", () => ({
  useGrowthStrategy: () => ({ strategy: {}, intakeStarted: true, loading: h.strategyLoading, reload: vi.fn() }),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
}));
vi.mock("../setup/SetupProvider", () => ({
  useSetupActive: () => null,
  useSetupOn: () => null,
  useSetupOptional: () => null,
}));
vi.mock("../AgentTab", () => ({ AgentTab: () => <div>chat</div> }));
vi.mock("../sidechat/SideChat", async (orig) => ({
  ...(await orig<typeof import("../sidechat/SideChat")>()),
  SideChat: () => <aside>chat</aside>,
}));

import { GrowthCoachPage } from "../GrowthCoachPage";
import { AutopilotTab } from "../AutopilotTab";
import { GrowthMemoSkeleton } from "./GrowthMemoSkeleton";

afterEach(cleanup);

function expectMemoSkeleton(extraText = "") {
  const sk = screen.getByRole("status", { name: "Loading growth plan" });
  expect(sk.querySelectorAll(".animate-pulse").length).toBeGreaterThanOrEqual(15);
  expect(sk.textContent).toBe(extraText);
  expect(sk.className).toContain("max-w-[720px]");
  expect(sk.querySelectorAll("[data-skeleton-step]")).toHaveLength(5);
  expect(sk.querySelectorAll("[data-skeleton-step] > .rounded-full")).toHaveLength(5);
  return sk;
}

describe("the Growth page while the plan loads", () => {
  it("the coach page shows the memo's skeleton", () => {
    render(<GrowthCoachPage />);
    expectMemoSkeleton();
  });

  it("the tab shows the memo's skeleton while the strategy read is out", () => {
    h.strategyLoading = true;
    render(<AutopilotTab />);
    expectMemoSkeleton();
  });

  it("uses the same bars as each section's own skeleton", () => {
    render(<GrowthMemoSkeleton />);
    expectMemoSkeleton();
  });
});
