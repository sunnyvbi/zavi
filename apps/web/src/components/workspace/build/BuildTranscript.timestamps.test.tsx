// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

type Reply = { status: number; body: unknown };
const net = vi.hoisted(() => ({
  pending: new Map<string, Array<(r: Reply) => void>>(),
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => {
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
vi.mock("@/lib/workspace/useBuildSessions", () => ({ notifyBuildSessionsChanged: () => {} }));

import { BuildTranscript } from "./BuildModePane";
import { shouldShowTimeStamp } from "@/lib/workspace/dayLabels";

const at = (day: number, h: number, m: number) => new Date(2026, 8, day, h, m).toISOString();

const SESSION = "1ce7760e-4491-4be1-85cd-8eebc60a4e4f";
const COLD_SESSION = "2df8871f-55a2-4cf2-96de-9ffd71b5f5b0";
const STATUS = "/api/workspace/autopilot/build-status";
const REFINES = "/api/workspace/autopilot/refines";

const refine = (id: string, message: string, created_at: string) => ({
  id: `${id}0000000-0000-4000-8000-000000000000`,
  message,
  status: "done",
  summary: `Did: ${message}`,
  created_at,
});

async function reply(path: string, r: Reply) {
  await waitFor(() => expect(net.pending.get(path)?.length ?? 0).toBeGreaterThan(0));
  const next = net.pending.get(path)!.shift()!;
  await act(async () => {
    next(r);
  });
}

const stamps = () =>
  screen.queryAllByRole("separator").map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 28, 12, 0));
});

afterEach(() => {
  cleanup();
  net.pending.clear();
  vi.useRealTimers();
});

describe("Build chat date and time stamps", () => {
  it("stamps the first message and every change request with its day and time, even minutes apart", async () => {
    render(<BuildTranscript sessionId={SESSION} />);
    await reply(STATUS, {
      status: 200,
      body: {
        run: {
          id: SESSION,
          objective: "Build product: Mohit — I want a bike rental landing page",
          status: "done",
          created_at: at(27, 22, 0),
          updated_at: at(27, 22, 14),
          stages: [],
        },
        target: { live_url: "https://spoke.test" },
      },
    });
    await reply(REFINES, {
      status: 200,
      body: {
        refines: [
          refine("c", "Add a map", at(28, 0, 5)),
          refine("b", "Add prices", at(27, 23, 30)),
          refine("a", "Bigger hero", at(27, 22, 20)),
        ],
      },
    });
    await screen.findByText("Add a map");
    expect(stamps()).toEqual(["Yesterday 10:00 PM", "Yesterday 10:20 PM", "Yesterday 11:30 PM", "Today 12:05 AM"]);
  });

  it("spaces every transcript row with its own margin instead of a space-y parent, in the skeleton and the loaded chat", async () => {
    render(<BuildTranscript sessionId={COLD_SESSION} />);
    const skeleton = screen.getByTestId("build-transcript-skeleton");
    expect(skeleton.className).not.toMatch(/space-y-/);
    const skeletonRows = Array.from(skeleton.children) as HTMLElement[];
    expect(skeletonRows.length).toBe(2);
    expect(skeletonRows[0]!.className).not.toMatch(/(^|\s)mt-/);
    expect(skeletonRows[1]!.className).toMatch(/(^|\s)mt-4(\s|$)/);

    await reply(STATUS, {
      status: 200,
      body: {
        run: {
          id: COLD_SESSION,
          objective: "Build product: Mohit — I want a bike rental landing page",
          status: "done",
          created_at: at(27, 22, 0),
          updated_at: at(27, 22, 14),
          stages: [],
        },
        target: { live_url: "https://spoke.test" },
      },
    });
    await reply(REFINES, {
      status: 200,
      body: { refines: [refine("a", "Bigger hero", at(27, 23, 30))] },
    });
    await screen.findByText("Bigger hero");

    const transcript = screen.getByTestId("build-transcript");
    expect(transcript.className).not.toMatch(/space-y-/);
    const rows = Array.from(transcript.children) as HTMLElement[];
    expect(rows.map((el) => el.getAttribute("role"))).toEqual([null, null, "separator", null]);
    expect(rows[0]!.className).not.toMatch(/(^|\s)mt-/);
    for (const row of rows.slice(1)) expect(row.className).toMatch(/(^|\s)mt-\d/);
    expect(rows[1]!.className).toMatch(/(^|\s)mt-4(\s|$)/);
    expect(rows[2]!.className).toMatch(/(^|\s)mt-5(\s|$)/);
    expect(rows[2]!.className).toMatch(/(^|\s)mb-1(\s|$)/);
    expect(rows[2]!.className).not.toMatch(/(^|\s)my-/);
    expect(rows[3]!.className).toMatch(/(^|\s)mt-4(\s|$)/);
  });
});

describe("shouldShowTimeStamp", () => {
  it("fires at exactly one hour, not a minute before", () => {
    expect(shouldShowTimeStamp(at(28, 5, 0), at(28, 5, 59))).toBe(false);
    expect(shouldShowTimeStamp(at(28, 5, 0), at(28, 6, 0))).toBe(true);
  });

  it("fires across midnight even when the gap is short, and on the first message", () => {
    expect(shouldShowTimeStamp(at(27, 23, 59), at(28, 0, 1))).toBe(true);
    expect(shouldShowTimeStamp(undefined, at(28, 0, 1))).toBe(true);
  });
});
