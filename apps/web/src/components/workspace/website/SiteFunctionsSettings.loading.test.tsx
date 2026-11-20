// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import {
  SITE_FUNCTIONS_TIMEOUT_MESSAGE,
  SITE_FUNCTIONS_TIMEOUT_MS,
  SITE_SECTION_COPY,
  SiteFunctionsSettings,
  type SiteFunctionsPayload,
  type SiteFunctionsSection,
} from "./SiteFunctionsSettings";

const BUILD = "d130919a-bec1-48bc-9dbf-fba65217f05a";

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const payload = (): SiteFunctionsPayload => ({
  secrets: { secrets: [{ name: "STRIPE_SECRET_KEY", updated_at: "2026-10-02T00:00:00Z" }], required: [] },
  functions: [
    { name: "create-checkout", kind: "http", url: null, cron: null, enabled: null, last_run: null },
    { name: "nightly", kind: "schedule", url: null, cron: "0 3 * * *", enabled: true, last_run: null },
  ],
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });
}

const OLD_FLAT_BLOCK = ".h-24.animate-pulse";
const READY_TEXT: Record<SiteFunctionsSection, string> = {
  secrets: "STRIPE_SECRET_KEY",
  functions: "create-checkout",
  schedules: "nightly",
};

beforeEach(() => {
  apiFetch.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Site settings sections while loading", () => {
  it.each(["secrets", "functions", "schedules"] as const)(
    "%s shows its own shaped, theme-token skeleton, then swaps it for the data in place",
    async (section) => {
      const pending = deferred<Response>();
      apiFetch.mockImplementation(() => pending.promise);
      const { container } = render(<SiteFunctionsSettings buildSessionId={BUILD} section={section} />);

      const status = screen.getByRole("status", { name: `Loading ${section}` });
      expect(status.getAttribute("aria-busy")).toBe("true");
      expect(status.getAttribute("data-section-skeleton")).toBe(section);
      const rows = status.querySelectorAll("li[data-skeleton-row]");
      expect(rows.length).toBe(3);
      for (const row of Array.from(rows)) expect(row.querySelectorAll(".bg-bone\\/70").length).toBeGreaterThanOrEqual(3);
      for (const row of Array.from(rows)) expect(row.className).toContain("h-14");
      const sweeps = Array.from(status.querySelectorAll(".animate-shimmer"));
      expect(sweeps.length).toBeGreaterThan(0);
      for (const s of sweeps) expect(s.className).toContain("motion-reduce:hidden");
      expect(container.querySelector(OLD_FLAT_BLOCK)).toBeNull();
      expect(container.querySelector(".animate-pulse")).toBeNull();
      expect(status.querySelector(".bg-\\[\\#f6f6f6\\]")).toBeNull();
      const heading = screen.getByRole("heading", { name: SITE_SECTION_COPY[section].title });
      expect(heading).toBeTruthy();
      expect(screen.getByText(SITE_SECTION_COPY[section].intro)).toBeTruthy();

      await act(async () => pending.resolve(json(200, payload())));

      expect(await screen.findByText(READY_TEXT[section])).toBeTruthy();
      expect(screen.queryByRole("status", { name: `Loading ${section}` })).toBeNull();
      expect(container.querySelector("[aria-busy='true']")).toBeNull();
      expect(screen.getAllByRole("heading", { name: SITE_SECTION_COPY[section].title })).toHaveLength(1);
    },
  );

  it("a failed read ends in the error state with a retry, never a skeleton, and the retry loads the data", async () => {
    apiFetch.mockResolvedValueOnce(json(500, { error: { message: "Database is down" } }));
    apiFetch.mockResolvedValueOnce(json(200, payload()));
    render(<SiteFunctionsSettings buildSessionId={BUILD} section="schedules" />);

    expect((await screen.findByRole("alert")).textContent).toContain("Database is down");
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelector("[aria-busy='true']")).toBeNull();
    expect(screen.getByRole("heading", { name: "Schedules" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("nightly")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("a read that never answers is cut off and ends in the error state, not an endless skeleton", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    apiFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return hangUntilAborted(init);
    });
    render(<SiteFunctionsSettings buildSessionId={BUILD} section="functions" />);
    expect(screen.getByRole("status", { name: "Loading functions" })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SITE_FUNCTIONS_TIMEOUT_MS - 1);
    });
    expect(screen.getByRole("status", { name: "Loading functions" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain(SITE_FUNCTIONS_TIMEOUT_MESSAGE);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("a function's runs show a runs-shaped skeleton until they arrive", async () => {
    const runs = deferred<Response>();
    apiFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/website/site-functions?")) return Promise.resolve(json(200, payload()));
      return runs.promise;
    });
    render(<SiteFunctionsSettings buildSessionId={BUILD} section="functions" />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Runs and logs" }))[0]);

    const status = screen.getByRole("status", { name: "Loading runs" });
    expect(status.querySelectorAll("li[data-skeleton-row]").length).toBe(2);
    expect(document.querySelector(OLD_FLAT_BLOCK)).toBeNull();

    await act(async () =>
      runs.resolve(json(200, { runs: [{ id: "r1", started_at: "2026-10-02T01:00:00Z", duration_ms: 40, status: "ok", http_status: 200, log: [] }] })),
    );
    expect(await screen.findByRole("list", { name: "Recent runs of create-checkout" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading runs" })).toBeNull();
  });
});
