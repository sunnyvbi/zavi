// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

type Reply = { status: number; body: unknown };
const net = vi.hoisted(() => ({
  pending: new Map<string, Array<(r: Reply) => void>>(),
  calls: [] as Array<{ path: string; body: unknown }>,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, opts: { body?: string } = {}) => {
    const key = path.split("?")[0]!;
    net.calls.push({
      path: key,
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
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
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  notifyBuildSessionsChanged: () => {},
}));

import { BuildTranscript } from "./BuildModePane";
import {
  BUILD_REFINE_FINISHED_EVENT,
  finishedRefines,
} from "@/lib/workspace/useBuildSession";

const SESSION = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const FAILED_ID = "dcee9f28-0000-4000-8000-000000000000";
const STATUS = "/api/workspace/autopilot/build-status";
const REFINES = "/api/workspace/autopilot/refines";
const REFINE = "/api/workspace/autopilot/refine-product";

const run = {
  id: SESSION,
  objective: "Build product: Mohit — A coming-soon page",
  status: "done",
  created_at: "2026-09-24T06:55:00.000Z",
  updated_at: "2026-09-24T07:10:00.000Z",
  stages: [],
};
const failed = {
  id: FAILED_ID,
  message: "Add a pricing section",
  status: "failed",
  created_at: "2026-09-24T08:00:00.000Z",
  failure_message: "Deploy failed",
};
const retried = {
  id: "aaaa0000-0000-4000-8000-000000000000",
  message: "Add a pricing section",
  status: "running",
  created_at: "2026-09-24T08:05:00.000Z",
  retry_of: FAILED_ID,
};

const count = (path: string) => net.calls.filter((c) => c.path === path).length;

async function reply(path: string, r: Reply) {
  await waitFor(() =>
    expect(net.pending.get(path)?.length ?? 0).toBeGreaterThan(0),
  );
  const next = net.pending.get(path)!.shift()!;
  await act(async () => {
    next(r);
  });
}

async function mountWithFailedChange() {
  render(<BuildTranscript sessionId={SESSION} />);
  await reply(STATUS, {
    status: 200,
    body: { run, target: { live_url: "https://shop.test" } },
  });
  await reply(REFINES, { status: 200, body: { refines: [failed] } });
  return screen.getByRole("button", { name: "Try again" });
}

afterEach(() => {
  cleanup();
  net.pending.clear();
  net.calls.length = 0;
});

describe("BuildTranscript Try again", () => {
  it("sends one retry for a double click, and stays disabled until the refetched list shows the retry", async () => {
    const button = await mountWithFailedChange();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(count(REFINE)).toBe(1);
    expect(net.calls.find((c) => c.path === REFINE)!.body).toEqual({
      retry_of: FAILED_ID,
      conductor_run_id: SESSION,
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await reply(REFINE, { status: 200, body: {} });
    expect(
      (screen.getByRole("button", { name: "Retrying…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await reply(REFINES, { status: 200, body: { refines: [failed] } });
    const still = screen.getByRole("button", {
      name: "Retrying…",
    }) as HTMLButtonElement;
    expect(still.disabled).toBe(true);
    fireEvent.click(still);
    expect(count(REFINE)).toBe(1);

    await reply(REFINES, { status: 200, body: { refines: [retried, failed] } });
    expect(
      screen.queryByRole("button", { name: /Try again|Retrying/ }),
    ).toBeNull();
    expect(screen.getByText("Getting started…")).toBeTruthy();
    expect(screen.getByTestId("change-working")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refetches and shows no error when the server says the retry already exists", async () => {
    const button = await mountWithFailedChange();
    const before = count(REFINES);
    fireEvent.click(button);
    await reply(REFINE, {
      status: 409,
      body: {
        error: {
          code: "refine_already_retried",
          message: "That change is already being retried.",
        },
      },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByText("That change is already being retried."),
    ).toBeNull();
    await waitFor(() => expect(count(REFINES)).toBeGreaterThan(before));
    expect(
      (screen.getByRole("button", { name: "Retrying…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await reply(REFINES, { status: 200, body: { refines: [retried, failed] } });
    expect(
      screen.queryByRole("button", { name: /Try again|Retrying/ }),
    ).toBeNull();
  });

  it("re-enables the button and shows why when the retry is refused", async () => {
    const button = await mountWithFailedChange();
    fireEvent.click(button);
    await reply(REFINE, {
      status: 404,
      body: {
        error: {
          code: "refine_not_retryable",
          message: "That change can't be retried.",
        },
      },
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "That change can't be retried.",
    );
    expect(
      (screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe("refine finished signal", () => {
  it("fires once when a polled change moves from running to done, never for one already done at first read", async () => {
    const seen: string[] = [];
    const listener = (event: Event) =>
      seen.push((event as CustomEvent<{ refineId: string }>).detail.refineId);
    window.addEventListener(BUILD_REFINE_FINISHED_EVENT, listener);
    try {
      render(<BuildTranscript sessionId={SESSION} />);
      await reply(STATUS, { status: 200, body: { run } });
      await reply(REFINES, {
        status: 200,
        body: {
          refines: [{ ...retried, id: "old", status: "done", retry_of: null }],
        },
      });
      expect(seen).toEqual([]);
      window.dispatchEvent(
        new CustomEvent("zavi:build-refine-started", {
          detail: { sessionId: SESSION },
        }),
      );
      await reply(REFINES, { status: 200, body: { refines: [retried] } });
      expect(seen).toEqual([]);
      await reply(REFINES, {
        status: 200,
        body: { refines: [{ ...retried, status: "done" }] },
      });
      expect(seen).toEqual([retried.id]);
    } finally {
      window.removeEventListener(BUILD_REFINE_FINISHED_EVENT, listener);
    }
  });

  it("lists only changes that just became terminal", () => {
    const a = { id: "a", message: "m", status: "running", created_at: "" };
    const b = { id: "b", message: "m", status: "done", created_at: "" };
    expect(
      finishedRefines([a, b], [{ ...a, status: "done" }, b]).map((r) => r.id),
    ).toEqual(["a"]);
    expect(finishedRefines([a], [a]).map((r) => r.id)).toEqual([]);
    expect(
      finishedRefines([], [{ ...a, status: "failed" }]).map((r) => r.id),
    ).toEqual(["a"]);
  });
});
