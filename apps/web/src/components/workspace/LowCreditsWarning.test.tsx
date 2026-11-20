// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch }));

vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({ openTab: vi.fn(), role: "owner", creditsEnforced: true }),
}));

vi.mock("./brain/useActiveTenant", () => ({
  useActiveTenant: () => "tenant-1",
}));

import { LowCreditsWarning } from "./LowCreditsWarning";
import { creditMeterModel } from "@/lib/workspace/runEstimate";

function creditsResponse(remaining: number, softWarn = true) {
  return {
    ok: true,
    json: async () => ({
      effective_available_display: remaining,
      included_allowance: 150_000,
      period_end: "2026-10-01T00:00:00Z",
      soft_warn: softWarn,
      unlimited: false,
    }),
  };
}

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

describe("LowCreditsWarning", () => {
  it("still shows the low-credits card (control)", async () => {
    apiFetch.mockResolvedValue(creditsResponse(5_000));
    render(<LowCreditsWarning />);
    expect(await screen.findByText(/credits left/)).toBeTruthy();
    expect(screen.getByText("Buy credits")).toBeTruthy();
    expect(screen.getByText("Upgrade")).toBeTruthy();
  });

  it("prints the real percentage left, not a hardcoded 20", async () => {
    apiFetch.mockResolvedValue(creditsResponse(30_000));
    render(<LowCreditsWarning />);
    expect(await screen.findByText("20% of credits left")).toBeTruthy();
    cleanup();

    apiFetch.mockResolvedValue(creditsResponse(15_000));
    render(<LowCreditsWarning />);
    expect(await screen.findByText("10% of credits left")).toBeTruthy();
  });

  it("fires at 20% even when the backend soft-warn flag is off", async () => {
    apiFetch.mockResolvedValue(creditsResponse(30_000, false));
    render(<LowCreditsWarning />);
    expect(await screen.findByText("20% of credits left")).toBeTruthy();
  });

  it("renders nothing while credits are healthy", async () => {
    apiFetch.mockResolvedValue(creditsResponse(45_000, false));
    const { container } = render(<LowCreditsWarning />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when credits are depleted", async () => {
    apiFetch.mockResolvedValue(creditsResponse(0));
    const { container } = render(<LowCreditsWarning />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/Out of credits/)).toBeNull();
    expect(screen.queryByText(/Upgrade/)).toBeNull();
    expect(container.innerHTML).toBe("");
  });
});

describe("LowCreditsWarning agrees with the sidebar credit meter", () => {
  afterEach(() => {
    cleanup();
    apiFetch.mockReset();
  });

  it("prints the sidebar's percentage when the pool holds a daily grant beyond the allowance", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        effective_available_display: 25_500,
        included_allowance: 150_000,
        credits_total: 170_000,
        period_end: "2026-09-30T00:00:00Z",
        soft_warn: true,
        unlimited: false,
      }),
    });
    const sidebar = creditMeterModel(25_500, 170_000, 0, "low").pctLabel;
    render(<LowCreditsWarning />);
    expect(await screen.findByText(`${sidebar}% of credits left`)).toBeTruthy();
    expect(sidebar).toBe(15);
    expect(screen.queryByText("17% of credits left")).toBeNull();
  });

  it("warns at the pool's 20% band, the same share the sidebar shows", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        effective_available_display: 32_000,
        included_allowance: 150_000,
        credits_total: 170_000,
        period_end: "2026-09-30T00:00:00Z",
        soft_warn: false,
        unlimited: false,
      }),
    });
    render(<LowCreditsWarning />);
    expect(await screen.findByText(`${creditMeterModel(32_000, 170_000, 0, "low").pctLabel}% of credits left`)).toBeTruthy();
  });
});
