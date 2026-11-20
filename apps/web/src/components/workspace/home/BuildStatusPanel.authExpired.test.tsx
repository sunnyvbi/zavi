// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("./AppPreviewFrame", () => ({ AppPreviewFrame: () => null }));

import {
  BuildStatusPanel,
  FAST_POLL_MS,
  UNAUTHORIZED_BEFORE_GIVING_UP,
} from "./BuildStatusPanel";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const RUNNING = {
  run: {
    id: "r1",
    status: "active",
    spend_usd: 0.12,
    max_usd: null,
    stages: [],
    created_at: null,
    updated_at: null,
  },
  target: { repo_url: null, live_url: null },
};

beforeEach(() => {
  apiFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("BuildStatusPanel — an expired session", () => {
  it("stops asking instead of polling a dead session twice a second", async () => {
    apiFetch.mockResolvedValue(json({}, 401));

    render(<BuildStatusPanel active />);

    await waitFor(
      () => expect(apiFetch.mock.calls.length).toBe(UNAUTHORIZED_BEFORE_GIVING_UP),
      { timeout: FAST_POLL_MS * UNAUTHORIZED_BEFORE_GIVING_UP + 1500 },
    );

    await new Promise((r) => setTimeout(r, FAST_POLL_MS + 400));
    expect(apiFetch).toHaveBeenCalledTimes(UNAUTHORIZED_BEFORE_GIVING_UP);
  });

  it("recovers when a 401 is followed by a good answer", async () => {
    let tick = 0;
    apiFetch.mockImplementation(async () => {
      tick += 1;
      return tick === 1 ? json({}, 401) : json(RUNNING);
    });

    render(<BuildStatusPanel active />);

    await waitFor(() => expect(apiFetch.mock.calls.length).toBeGreaterThan(2), {
      timeout: FAST_POLL_MS * 3,
    });
    expect(screen.queryByText(/session expired/i)).toBeNull();
  });

  it("names the session, not the status code, and offers the way back", async () => {
    apiFetch.mockResolvedValue(json({}, 401));

    render(<BuildStatusPanel active />);

    await waitFor(() => expect(screen.getByText(/session expired/i)).toBeTruthy(), {
      timeout: FAST_POLL_MS * UNAUTHORIZED_BEFORE_GIVING_UP + 1500,
    });
    expect(screen.getByRole("link", { name: /sign in again/i })).toBeTruthy();
    expect(screen.queryByText(/Will retry/i)).toBeNull();
    expect(screen.queryByText(/HTTP 401/)).toBeNull();
  });

  it("still says 'will retry' on a 5xx, which a later tick can genuinely fix", async () => {
    apiFetch.mockResolvedValue(json({}, 503));

    render(<BuildStatusPanel active />);

    await waitFor(() => expect(screen.getByText(/Will retry/i)).toBeTruthy());
    expect(screen.queryByText(/session expired/i)).toBeNull();
  });

  it("keeps polling a healthy build, so the stop is scoped to the 401", async () => {
    apiFetch.mockImplementation(async () => json(RUNNING));

    render(<BuildStatusPanel active />);

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(apiFetch.mock.calls.length).toBeGreaterThan(1), {
      timeout: FAST_POLL_MS + 1500,
    });
  });
});
