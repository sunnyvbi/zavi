// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Reply = { status: number; body: unknown };
const net = vi.hoisted(() => ({
  pending: new Map<string, Array<(r: Reply) => void>>(),
  calls: [] as string[],
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => {
    net.calls.push(path);
    const key = path.split("?")[0]!;
    return new Promise((resolve) => {
      const queue = net.pending.get(key) ?? [];
      queue.push((r: Reply) =>
        resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body }),
      );
      net.pending.set(key, queue);
    });
  },
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  notifyBuildSessionsChanged: () => {},
}));

import { BuildTranscript } from "./BuildModePane";

const SESSION = "d97e436d-52d9-45e3-8b03-8d9c05a48ee9";
const STATUS = "/api/workspace/autopilot/build-status";
const REFINES = "/api/workspace/autopilot/refines";
const RUN_CREDITS = "/api/billing/run-credits";

async function reply(path: string, r: Reply) {
  await waitFor(() => expect(net.pending.get(path)?.length ?? 0).toBeGreaterThan(0));
  const next = net.pending.get(path)!.shift()!;
  await act(async () => {
    next(r);
  });
}

async function openBuildMenu(entry: unknown) {
  render(<BuildTranscript sessionId={SESSION} />);
  await reply(STATUS, {
    status: 200,
    body: {
      run: {
        id: SESSION,
        objective: "Build product: Mohit — a bakery site",
        status: "done",
        created_at: "2026-10-05T10:00:00.000Z",
        updated_at: "2026-10-05T10:02:43.000Z",
        stages: [],
      },
      target: { live_url: "https://shop.test" },
    },
  });
  await reply(REFINES, { status: 200, body: { refines: [] } });
  fireEvent.click(screen.getByRole("button", { name: "More options" }));
  await reply(RUN_CREDITS, { status: 200, body: { runs: { [SESSION]: entry } } });
  const call = net.calls.find((path) => path.startsWith(RUN_CREDITS));
  expect(call).toBe(`${RUN_CREDITS}?ids=${encodeURIComponent(SESSION)}`);
  return screen.getByRole("dialog", { name: "Run details" });
}

afterEach(() => {
  cleanup();
  net.pending.clear();
  net.calls = [];
});

describe("build card credits", () => {
  it("shows a build whose stages settled without a debit as free work Zavi covered, never 'None'", async () => {
    const dialog = await openBuildMenu({ credits: 0, usd: 0, status: "settled", covered: 2716 });
    const free = await within(dialog).findByText("Free");
    const detail = within(dialog).getByText("Zavi covered 2,716 credits");
    expect(free).not.toBe(detail);
    expect(free.contains(detail)).toBe(false);
    expect(within(dialog).getByText("Credits")).toBeTruthy();
    expect(dialog.textContent).not.toContain("None");
    expect(dialog.textContent).not.toContain("Not charged");
  });

  it("reads a zero-debit settle from a server that predates the covered field as not charged", async () => {
    const dialog = await openBuildMenu({ credits: 0, usd: 0, status: "settled" });
    expect(await within(dialog).findByText("Not charged")).toBeTruthy();
    expect(within(dialog).queryByText("None")).toBeNull();
    expect(within(dialog).queryByText("Free")).toBeNull();
  });

  it("shows exactly what was charged when Zavi absorbed only part of the work", async () => {
    const dialog = await openBuildMenu({ credits: 1200, usd: 3, status: "settled", covered: 300 });
    expect(await within(dialog).findByText("1,200 credits")).toBeTruthy();
    expect(within(dialog).getByText("Credits")).toBeTruthy();
    expect(dialog.textContent).not.toContain("Not charged");
    expect(within(dialog).queryByText("Free")).toBeNull();
    expect(dialog.textContent).not.toContain("300");
  });

  it("keeps 'None' for a run with no ledger rows and no paid work", async () => {
    const dialog = await openBuildMenu({ credits: 0, usd: 0, status: "none" });
    expect(await within(dialog).findByText("None")).toBeTruthy();
    expect(within(dialog).getByText("Credits")).toBeTruthy();
    expect(dialog.textContent).not.toContain("Not charged");
  });

  it("shows a run still settling as 'Settling…', not a number or 'None'", async () => {
    const dialog = await openBuildMenu({ credits: 0, usd: 0, status: "pending" });
    expect(await within(dialog).findByText("Settling…")).toBeTruthy();
    expect(within(dialog).queryByText("None")).toBeNull();
  });

  it("shows a refunded run as 'Not charged'", async () => {
    const dialog = await openBuildMenu({ credits: 0, usd: 0, status: "refunded" });
    expect(await within(dialog).findByText("Not charged")).toBeTruthy();
    expect(within(dialog).queryByText("None")).toBeNull();
  });

  it("lifts the open menu into its own layer above the reply content it opens over", async () => {
    const dialog = await openBuildMenu({ credits: 5, usd: 0.0125, status: "settled" });
    const menu = dialog.parentElement as HTMLElement;
    expect(menu.className.split(/\s+/)).toEqual(expect.arrayContaining(["relative", "z-40"]));
    expect(dialog.className.split(/\s+/)).toContain("z-50");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(menu.className.split(/\s+/)).not.toContain("z-40");
  });
});
