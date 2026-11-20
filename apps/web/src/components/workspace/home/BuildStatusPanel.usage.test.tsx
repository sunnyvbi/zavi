// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("./AppPreviewFrame", () => ({ AppPreviewFrame: () => null }));

import { BuildStatusPanel } from "./BuildStatusPanel";

const body = (run: Record<string, unknown>) =>
  new Response(
    JSON.stringify({
      run: { id: "r1", status: "done", spend_usd: 5, max_usd: 50, stages: [], created_at: null, updated_at: null, ...run },
      target: { repo_url: null, live_url: null },
    }),
    { status: 200 },
  );

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

describe("BuildStatusPanel usage", () => {
  it("shows real credits used, not the estimate counter or its cap", async () => {
    apiFetch.mockResolvedValue(body({ used_usd: 11.19, used_credits: 4480 }));
    render(<BuildStatusPanel active={false} creditsEnforced />);
    expect(await screen.findByText("Cost 4,480 cr")).toBeTruthy();
    expect(screen.queryByText(/2,000 cr|20,000 cr/)).toBeNull();
  });

  it("shows dollars when credits aren't enforced", async () => {
    apiFetch.mockResolvedValue(body({ used_usd: 11.19 }));
    render(<BuildStatusPanel active={false} />);
    expect(await screen.findByText("$11.19 used")).toBeTruthy();
    expect(screen.queryByText(/\$5\.00|\$50\.00/)).toBeNull();
  });

  it("shows nothing when real usage couldn't be read", async () => {
    apiFetch.mockResolvedValue(body({ used_usd: null, used_credits: null }));
    render(<BuildStatusPanel active={false} creditsEnforced />);
    await screen.findByText(/building/i);
    expect(screen.queryByText(/Cost|used/)).toBeNull();
  });
});
