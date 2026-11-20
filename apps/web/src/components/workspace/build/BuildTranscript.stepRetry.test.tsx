// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

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
vi.mock("lottie-web", () => ({
  default: { loadAnimation: () => ({ destroy: () => {} }) },
}));

import { BuildTranscript, deriveBuildSteps, STEP_LABELS } from "./BuildModePane";
import { WebsiteBuildProgress } from "../website/WebsiteBuildProgress";
import { retryingStepLabel } from "@/lib/workspace/buildRetry";
import type { BuildStageRow } from "@/lib/workspace/useBuildPreview";

const SESSION = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const STATUS = "/api/workspace/autopilot/build-status";
const REFINES = "/api/workspace/autopilot/refines";

const stages = (scaffold: BuildStageRow): BuildStageRow[] => [
  { stage: "provision", status: "done" },
  { stage: "spec", status: "done" },
  scaffold,
  { stage: "build", status: "pending" },
];

const RETRYING = stages({ stage: "scaffold", status: "running", attempt: 2 });
const FIRST_TRY = stages({ stage: "scaffold", status: "running" });

async function reply(path: string, r: Reply) {
  await waitFor(() => expect(net.pending.get(path)?.length ?? 0).toBeGreaterThan(0));
  const next = net.pending.get(path)!.shift()!;
  await act(async () => {
    next(r);
  });
}

async function mount(buildStages: BuildStageRow[]) {
  render(<BuildTranscript sessionId={SESSION} />);
  await reply(STATUS, {
    status: 200,
    body: {
      run: {
        id: SESSION,
        objective: "Build product: Paws & Suds — grooming bookings",
        status: "active",
        created_at: "2026-09-29T17:39:00.000Z",
        updated_at: "2026-09-29T17:52:00.000Z",
        stages: buildStages,
      },
      target: { live_url: null },
      is_current: true,
    },
  });
  await reply(REFINES, { status: 200, body: { refines: [] } });
}

afterEach(() => {
  cleanup();
  net.pending.clear();
});

describe("a build whose stage rows have not arrived yet", () => {
  it("shows the site steps from the first paint and never flashes the old four-step list", async () => {
    await mount([]);
    await waitFor(() => expect(screen.getByText("Setting up your workspace")).toBeTruthy());
    expect(screen.getByText("Building the interface")).toBeTruthy();
    expect(screen.queryByText("Understanding your request")).toBeNull();
    expect(screen.queryByText("Creating the app structure")).toBeNull();
  });
});

describe("a retried build step is shown, not hidden (DEL-1323 B18/B19)", () => {
  it("the Build chat step list says the app structure is being retried, attempt 2", async () => {
    await mount(RETRYING);
    await waitFor(() => expect(screen.getByText("Retrying app structure, attempt 2")).toBeTruthy());
    expect(screen.queryByText("Creating the app structure")).toBeNull();
    expect(screen.getByText("Setting up your workspace")).toBeTruthy();
    expect(screen.getByText("Building the interface")).toBeTruthy();
  });

  it("a first try keeps the plain step name", async () => {
    await mount(FIRST_TRY);
    await waitFor(() => expect(screen.getByText("Creating the app structure")).toBeTruthy());
    expect(screen.queryByText(/Retrying/)).toBeNull();
  });

  it("the progress screen names the retry under the bar", () => {
    render(<WebsiteBuildProgress stages={RETRYING} failure={null} failed={false} />);
    expect(screen.getByTestId("build-progress-retry").textContent).toBe("Retrying app structure, attempt 2");
  });

  it("with no attempt on the stages (key off) the progress screen and step list are byte for byte the old ones", () => {
    const withoutAttempt = renderToStaticMarkup(
      <WebsiteBuildProgress stages={FIRST_TRY} failure={null} failed={false} />,
    );
    expect(withoutAttempt).not.toContain("build-progress-retry");
    expect(withoutAttempt).not.toContain("Retrying");
    const labels = deriveBuildSteps(FIRST_TRY, "active", "building").map((s) => s.label);
    expect(labels).toEqual(STEP_LABELS.filter(([key]) => key !== "checks").map(([, label]) => label));
  });

  it("a failed run shows the failed step name, never a retry", () => {
    const steps = deriveBuildSteps(RETRYING, "failed", "failed");
    expect(steps.map((s) => s.label)).not.toContain("Retrying app structure, attempt 2");
    render(
      <WebsiteBuildProgress
        stages={stages({ stage: "scaffold", status: "failed", attempt: 3 })}
        failure={{ message: "no code reached the repo", stage: "scaffold" }}
        failed
      />,
    );
    expect(screen.queryByTestId("build-progress-retry")).toBeNull();
  });

  it("only a running step with attempt 2 or more is called a retry", () => {
    expect(retryingStepLabel(stages({ stage: "scaffold", status: "running", attempt: 1 }))).toBeNull();
    expect(retryingStepLabel(stages({ stage: "scaffold", status: "done", attempt: 2 }))).toBeNull();
    expect(retryingStepLabel(stages({ stage: "scaffold", status: "pending", attempt: 2 }))).toBeNull();
    expect(retryingStepLabel(stages({ stage: "scaffold", status: "running", attempt: Number.NaN }))).toBeNull();
    expect(retryingStepLabel(stages({ stage: "scaffold", status: "dispatched", attempt: 3 }))).toBe(
      "Retrying app structure, attempt 3",
    );
    expect(
      retryingStepLabel([
        { stage: "scaffold", status: "done", attempt: 2 },
        { stage: "build", status: "running", attempt: 2 },
      ]),
    ).toBe("Retrying interface, attempt 2");
  });
});
