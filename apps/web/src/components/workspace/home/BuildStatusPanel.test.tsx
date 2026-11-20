import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BuildStatusPanel,
  progressPct,
  isBuildTerminal,
  computeElapsedMs,
  formatElapsed,
} from "./BuildStatusPanel";

describe("progressPct — streamed-feel progress bar", () => {
  it("is 0 with no stages", () => {
    expect(progressPct([])).toBe(0);
  });

  it("is 0 when every stage is pending", () => {
    const stages = Array.from({ length: 5 }, () => ({ status: "pending" }));
    expect(progressPct(stages)).toBe(0);
  });

  it("counts a running stage as half-credit so the bar moves the moment a stage starts", () => {
    const stages = [
      { status: "running" },
      { status: "pending" },
      { status: "pending" },
      { status: "pending" },
      { status: "pending" },
    ];
    expect(progressPct(stages)).toBe(10);
  });

  it("treats the durable dispatched status as running", () => {
    const stages = [
      { status: "dispatched" },
      { status: "pending" },
      { status: "pending" },
      { status: "pending" },
      { status: "pending" },
    ];
    expect(progressPct(stages)).toBe(10);
  });

  it("advances as stages complete (scaffold done, build running)", () => {
    const stages = [
      { status: "done" },
      { status: "done" },
      { status: "done" },
      { status: "running" },
      { status: "pending" },
    ];
    expect(progressPct(stages)).toBe(70);
  });

  it("is 100 when every stage is done", () => {
    const stages = Array.from({ length: 5 }, () => ({ status: "done" }));
    expect(progressPct(stages)).toBe(100);
  });

  it("treats a failed stage as completed for the bar (no regression on a terminal run)", () => {
    const stages = [
      { status: "done" },
      { status: "done" },
      { status: "done" },
      { status: "done" },
      { status: "failed" },
    ];
    expect(progressPct(stages)).toBe(100);
  });
});

describe("BuildStatusPanel — initial render (no false-live)", () => {
  it("shows the progress bar and the 4 stage rows but no preview iframe before any data", () => {
    const html = renderToStaticMarkup(<BuildStatusPanel active />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("Provision infrastructure");
    expect(html).toContain("Build the app");
    expect(html).not.toContain("QA the build");
    expect(html).not.toContain("<iframe");
    expect(html).toContain("width:0%");
  });
});

describe("isBuildTerminal", () => {
  it("true only for done/failed/halted", () => {
    expect(isBuildTerminal("done")).toBe(true);
    expect(isBuildTerminal("failed")).toBe(true);
    expect(isBuildTerminal("halted")).toBe(true);
    expect(isBuildTerminal("active")).toBe(false);
    expect(isBuildTerminal("provisioning")).toBe(false);
    expect(isBuildTerminal(null)).toBe(false);
    expect(isBuildTerminal(undefined)).toBe(false);
  });
});

describe("formatElapsed", () => {
  it("formats M:SS and H:MM:SS", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(5_000)).toBe("0:05");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(599_000)).toBe("9:59");
    expect(formatElapsed(3_661_000)).toBe("1:01:01");
  });
});

describe("computeElapsedMs", () => {
  const CREATED = "2026-07-07T12:00:00.000Z";
  const start = Date.parse(CREATED);

  it("returns null for missing/unparseable created_at", () => {
    expect(computeElapsedMs(null, null, false, start)).toBeNull();
    expect(computeElapsedMs(undefined, null, false, start)).toBeNull();
    expect(computeElapsedMs("not-a-date", null, false, start)).toBeNull();
  });

  it("while running: now − created_at", () => {
    expect(computeElapsedMs(CREATED, null, false, start + 90_000)).toBe(90_000);
  });

  it("clamps negative (clock skew: created_at ahead of now) to 0", () => {
    expect(computeElapsedMs(CREATED, null, false, start - 5_000)).toBe(0);
  });

  it("once terminal: uses updated_at − created_at (frozen), not now", () => {
    const updated = "2026-07-07T12:03:00.000Z";
    expect(computeElapsedMs(CREATED, updated, true, start + 600_000)).toBe(180_000);
  });

  it("terminal but updated_at missing/bad → falls back to now", () => {
    expect(computeElapsedMs(CREATED, null, true, start + 120_000)).toBe(120_000);
    expect(computeElapsedMs(CREATED, "bad", true, start + 120_000)).toBe(120_000);
  });
});
