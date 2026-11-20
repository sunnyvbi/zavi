// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ScheduleView } from "./ScheduleView";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const openGates: Array<() => void> = [];

function deferredSchedule() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  openGates.push(release);
  apiFetch.mockImplementation(async () => {
    await gate;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        schedule: {
          agent_slug: "google_ads",
          cron_expression: "0 9 * * *",
          enabled: true,
          last_fired_at: null,
          timezone: "America/Los_Angeles",
        },
      }),
    };
  });
  return async () => {
    release();
    await act(async () => {
      for (let i = 0; i < 16; i += 1) await Promise.resolve();
    });
  };
}

const card = (root: HTMLElement): HTMLElement => {
  const el = root.querySelector(".rounded-lg.border.bg-white.p-4");
  if (!el) throw new Error("no schedule card in this tree");
  return el as HTMLElement;
};

beforeEach(() => apiFetch.mockReset());

afterEach(async () => {
  for (const release of openGates.splice(0)) release();
  await act(async () => {
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
  });
  cleanup();
});

describe("ScheduleView's skeleton holds the form's shape", () => {
  it("draws the card as the same element, with the same classes, in both states", async () => {
    const settle = deferredSchedule();
    const { container } = render(<ScheduleView slug="google_ads" />);

    const loading = card(container);
    const loadingTag = loading.tagName;
    const loadingClass = loading.className;

    await settle();

    const loaded = card(container);
    expect(loaded.tagName).toBe(loadingTag);
    expect(loaded.className).toBe(loadingClass);
  });

  it("keeps the two-column row two columns while it loads", async () => {
    const settle = deferredSchedule();
    const { container } = render(<ScheduleView slug="google_ads" />);

    expect(card(container).querySelector(".sm\\:grid-cols-2")).not.toBeNull();

    await settle();

    expect(card(container).querySelector(".sm\\:grid-cols-2")).not.toBeNull();
  });

  it("reserves a block for every block the form lands with", async () => {
    const settle = deferredSchedule();
    const { container } = render(<ScheduleView slug="google_ads" />);

    const reserved = card(container).childElementCount;

    await settle();

    expect(reserved).toBe(card(container).childElementCount);
  });

  it("leaves a visible placeholder when the reader has asked for no motion", async () => {
    const settle = deferredSchedule();
    const { container } = render(<ScheduleView slug="google_ads" />);

    const sweeps = Array.from(container.querySelectorAll(".animate-shimmer"));
    expect(sweeps.length).toBeGreaterThan(0);

    for (const sweep of sweeps) {
      expect(sweep.className).toContain("motion-reduce:hidden");
      const block = sweep.parentElement as HTMLElement;
      expect(block.className).toContain("bg-bone/70");
      expect(block.className).not.toContain("animate-");
    }

    const animated = Array.from(container.querySelectorAll('[class*="animate-"]'));
    for (const el of animated) {
      expect(el.className).toMatch(/motion-reduce:(hidden|animate-none)/);
    }

    await settle();
  });
});

describe("the file cannot leave a read in flight", () => {
  it("has released every gate it opened, so vitest can exit", () => {
    expect(openGates).toEqual([]);
  });
});
