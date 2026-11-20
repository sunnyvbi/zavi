// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const api = vi.hoisted(() => ({ body: null as unknown }));
vi.mock("@/lib/api", () => ({
  apiFetch: async () => ({ ok: true, status: 200, json: async () => api.body }),
}));
vi.mock("lottie-web", () => ({ default: { loadAnimation: () => ({ destroy: () => {} }) } }));

import { BuildStatusPanel } from "./BuildStatusPanel";
import { buildProgressBody, WebsiteBuildProgress } from "../website/WebsiteBuildProgress";
import { buildPublishesOnRequest } from "@/lib/workspace/buildPublish";
import { buildEstimateText, buildRemainingMs } from "@/lib/workspace/buildEstimate";
import type { BuildStageRow } from "@/lib/workspace/useBuildPreview";

const MIN = 60_000;
const T0 = Date.parse("2026-10-01T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const SITE_BUDGET: Record<string, number> = {
  provision: 1 * MIN,
  spec: 4 * MIN,
  scaffold: 25 * MIN,
  build: 10 * MIN,
  qa: 8 * MIN,
  deploy: 3 * MIN,
};
const OLD_FLOW_BUDGET: Record<string, number> = {
  provision: 2 * MIN,
  spec: 4 * MIN,
  scaffold: 25 * MIN,
  build: 20 * MIN,
};

function rows(budget: Record<string, number>, states: Record<string, { status: string; started?: number }>): BuildStageRow[] {
  return Object.entries(budget).map(([stage, expected_ms]) => {
    const st = states[stage] ?? { status: "pending" };
    return { stage, status: st.status, started_at: st.started === undefined ? null : iso(st.started), expected_ms };
  });
}

function minutesIn(text: string | null | undefined): number | null {
  const m = /About (\d+) minutes? left/.exec(text ?? "");
  return m ? Number(m[1]) : null;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function statusBody(stages: BuildStageRow[]) {
  return {
    run: {
      id: "run-1",
      status: "active",
      spend_usd: 0,
      max_usd: null,
      created_at: iso(T0),
      updated_at: iso(T0),
      stages: stages.map((s) => ({ error: null, ...s })),
    },
    target: { repo_url: null, live_url: null },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  try {
    window.sessionStorage.clear();
  } catch {}
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("B18: one build estimate, from the stage budgets", () => {
  it("a new site build starts at the full 51 minute budget, never a faster made-up target", () => {
    const stages = rows(SITE_BUDGET, { provision: { status: "running", started: T0 } });
    expect(buildRemainingMs(stages, T0)).toBe(51 * MIN);
    expect(buildEstimateText(stages, T0)).toBe("About 51 minutes left");
  });

  it("an old-flow build reads its own budgets: 51 minutes over provision, spec, scaffold and build", () => {
    const stages = rows(OLD_FLOW_BUDGET, {});
    expect(buildEstimateText(stages, T0)).toBe("About 51 minutes left");
  });

  it("counts down inside a stage and drops each stage's budget as it finishes", () => {
    const scaffoldStart = T0 + 5 * MIN;
    const stages = rows(SITE_BUDGET, {
      provision: { status: "done", started: T0 },
      spec: { status: "done", started: T0 + MIN },
      scaffold: { status: "running", started: scaffoldStart },
    });
    expect(buildEstimateText(stages, scaffoldStart)).toBe("About 46 minutes left");
    expect(buildEstimateText(stages, scaffoldStart + 10 * MIN + 1)).toBe("About 36 minutes left");
    const scaffoldDone = rows(SITE_BUDGET, {
      provision: { status: "done" },
      spec: { status: "done" },
      scaffold: { status: "done" },
      build: { status: "running", started: scaffoldStart + 12 * MIN },
    });
    expect(buildEstimateText(scaffoldDone, scaffoldStart + 12 * MIN)).toBe("About 21 minutes left");
  });

  it("a stage that finished early does not make later stages look faster than their budgets", () => {
    const stages = rows(SITE_BUDGET, {
      provision: { status: "done" },
      spec: { status: "done" },
      scaffold: { status: "done" },
      build: { status: "pending" },
    });
    expect(buildRemainingMs(stages, T0)).toBe((10 + 8 + 3) * MIN);
  });

  it("a stage past its budget but not yet slow leaves at least one minute, never zero", () => {
    const stages = rows({ build: 10 * MIN }, { build: { status: "running", started: T0 } });
    expect(buildEstimateText(stages, T0 + 11 * MIN)).toBe("About 1 minute left");
  });

  it("a two-step publish-on-request build counts setting up and building only: 11 minutes, with no publishing time in it", () => {
    const onRequest = rows({ provision: 1 * MIN, build: 10 * MIN }, { provision: { status: "running", started: T0 } });
    const withPublishStep = rows({ provision: 1 * MIN, build: 10 * MIN, deploy: 3 * MIN }, { provision: { status: "running", started: T0 } });
    expect(buildPublishesOnRequest(onRequest, false)).toBe(true);
    expect(buildPublishesOnRequest(withPublishStep, true)).toBe(false);
    expect(buildEstimateText(onRequest, T0)).toBe("About 11 minutes left");
    expect(buildEstimateText(withPublishStep, T0)).toBe("About 14 minutes left");

    const building = rows({ provision: 1 * MIN, build: 10 * MIN }, { provision: { status: "done" }, build: { status: "running", started: T0 } });
    expect(buildEstimateText(building, T0 + 9 * MIN + 30_000)).toBe("About 1 minute left");
    expect(buildEstimateText(building, T0 + 12 * MIN)).toBe("About 1 minute left");
    expect(buildEstimateText(building, T0 + 12 * MIN + 30_001)).toBeNull();

    const built = rows({ provision: 1 * MIN, build: 10 * MIN }, { provision: { status: "done" }, build: { status: "done" } });
    expect(buildEstimateText(built, T0 + 20 * MIN)).toBeNull();
  });

  it("the preview loader words a publish-on-request estimate without any publishing promise", () => {
    const onRequest = rows({ provision: 1 * MIN, build: 10 * MIN }, { provision: { status: "done" }, build: { status: "running", started: T0 } });
    vi.setSystemTime(T0 + 4 * MIN);
    const loader = render(<WebsiteBuildProgress stages={onRequest} failure={null} failed={false} runId="run-9" publishOnRequest />);
    const loaderText = loader.container.textContent ?? "";
    expect(loaderText).toContain(buildProgressBody("About 6 minutes left", true));
    expect(loaderText).toContain("press Publish to put it on its address");
    for (const text of [loaderText, buildProgressBody(null, true)]) {
      expect(text).not.toMatch(/few minutes|moment it's live|live address|continues in the background|Publishing/);
    }
  });

  it.each([
    ["a step is far past its budget", rows(SITE_BUDGET, { provision: { status: "running", started: T0 } }), T0 + 2 * MIN],
    ["a stage failed", rows(SITE_BUDGET, { provision: { status: "failed", started: T0 } }), T0],
    ["every stage is done", rows({ build: MIN }, { build: { status: "done" } }), T0],
    ["an open stage has no budget", [{ stage: "build", status: "pending" } as BuildStageRow], T0],
    ["there are no stages yet", [] as BuildStageRow[], T0],
  ] as const)("says no number when %s", (_label, stages, now) => {
    expect(buildEstimateText(stages, now)).toBeNull();
  });

  it("the Home panel and the preview loader show the same number, and both move together as time passes and stages finish", async () => {
    const scaffoldStart = T0 + 4 * MIN;
    vi.setSystemTime(scaffoldStart + 3 * MIN);
    const midScaffold = rows(OLD_FLOW_BUDGET, {
      provision: { status: "done" },
      spec: { status: "done" },
      scaffold: { status: "running", started: scaffoldStart },
    });
    api.body = statusBody(midScaffold);
    const panel = render(<BuildStatusPanel active={false} />);
    await flush();
    const loader = render(<WebsiteBuildProgress stages={midScaffold} failure={null} failed={false} runId="run-1" />);

    const panelMinutes = () => minutesIn(panel.container.textContent);
    const loaderMinutes = () => minutesIn(loader.container.textContent);
    expect(panelMinutes()).toBe(42);
    expect(loaderMinutes()).toBe(42);
    expect(panel.container.textContent).not.toMatch(/few minutes/);
    expect(loader.container.textContent).not.toMatch(/few minutes/);

    panel.unmount();
    vi.setSystemTime(scaffoldStart + 13 * MIN);
    const panelLater = render(<BuildStatusPanel active={false} />);
    await flush();
    loader.rerender(<WebsiteBuildProgress stages={midScaffold} failure={null} failed={false} runId="run-1" />);
    act(() => void vi.advanceTimersByTime(1000));
    expect(minutesIn(panelLater.container.textContent)).toBe(32);
    expect(loaderMinutes()).toBe(32);

    const buildRunning = rows(OLD_FLOW_BUDGET, {
      provision: { status: "done" },
      spec: { status: "done" },
      scaffold: { status: "done" },
      build: { status: "running", started: Date.now() },
    });
    api.body = statusBody(buildRunning);
    panelLater.unmount();
    const panelAfterScaffold = render(<BuildStatusPanel active={false} />);
    await flush();
    loader.rerender(<WebsiteBuildProgress stages={buildRunning} failure={null} failed={false} runId="run-1" />);
    expect(minutesIn(panelAfterScaffold.container.textContent)).toBe(20);
    expect(loaderMinutes()).toBe(20);
  });
});
