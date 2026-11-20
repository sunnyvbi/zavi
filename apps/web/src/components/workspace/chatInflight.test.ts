import { describe, it, expect } from "vitest";
import {
  isStreamDraftLive,
  resolveInflight,
  type InflightRow,
} from "./chatInflight";

const userRow = (runId: string | null): InflightRow => ({
  kind: "chat_user",
  agent_run_id: runId,
});
const assistantRow = (runId: string): InflightRow => ({
  kind: "chat_assistant",
  agent_run_id: runId,
});

describe("resolveInflight — in-flight 'working…' indicator decision", () => {
  it("shows immediately on the freshly-sent run BEFORE the DB derives activeRunId (the blank-gap fix)", () => {
    const out = resolveInflight({
      activeRunId: null,
      activeTrigger: null,
      pendingRunId: "run-1",
      rows: [userRow(null)],
    });
    expect(out).toEqual({ show: true, runId: "run-1" });
  });

  it("shows on the DB-derived activeRunId (existing path) when chat-triggered", () => {
    const out = resolveInflight({
      activeRunId: "run-1",
      activeTrigger: "chat",
      pendingRunId: null,
      rows: [userRow("run-1")],
    });
    expect(out).toEqual({ show: true, runId: "run-1" });
  });

  it("shows for a manual trigger too", () => {
    const out = resolveInflight({
      activeRunId: "run-2",
      activeTrigger: "manual",
      pendingRunId: null,
      rows: [userRow("run-2")],
    });
    expect(out.show).toBe(true);
  });

  it("HIDES the moment the assistant reply for the run lands (DB path)", () => {
    const out = resolveInflight({
      activeRunId: "run-1",
      activeTrigger: "chat",
      pendingRunId: null,
      rows: [userRow("run-1"), assistantRow("run-1")],
    });
    expect(out).toEqual({ show: false, runId: null });
  });

  it("HIDES the moment the assistant reply lands (pending path) — covers an inline card arriving (a chat_assistant row)", () => {
    const out = resolveInflight({
      activeRunId: null,
      activeTrigger: null,
      pendingRunId: "run-9",
      rows: [userRow(null), assistantRow("run-9")],
    });
    expect(out).toEqual({ show: false, runId: null });
  });

  it("HIDES a pending run that already went terminal (failed run must not spin forever)", () => {
    const out = resolveInflight({
      activeRunId: null,
      activeTrigger: null,
      pendingRunId: "run-dead",
      rows: [userRow(null)],
      terminalRunIds: new Set(["run-dead"]),
    });
    expect(out).toEqual({ show: false, runId: null });
  });

  it("HIDES a terminal activeRunId even with no assistant reply (dead run, e.g. dispatch_error)", () => {
    const out = resolveInflight({
      activeRunId: "run-dead",
      activeTrigger: "chat",
      pendingRunId: null,
      rows: [userRow("run-dead")],
      terminalRunIds: new Set(["run-dead"]),
    });
    expect(out).toEqual({ show: false, runId: null });
  });

  it("does NOT show for cron / scheduled runs (no user bubble to attach to)", () => {
    expect(
      resolveInflight({
        activeRunId: "run-cron",
        activeTrigger: "cron",
        pendingRunId: null,
        rows: [],
      }).show,
    ).toBe(false);
    expect(
      resolveInflight({
        activeRunId: "run-sched",
        activeTrigger: "scheduled",
        pendingRunId: null,
        rows: [],
      }).show,
    ).toBe(false);
  });

  it("shows nothing when there is neither an active nor a pending run", () => {
    expect(
      resolveInflight({
        activeRunId: null,
        activeTrigger: null,
        pendingRunId: null,
        rows: [],
      }),
    ).toEqual({ show: false, runId: null });
  });

  it("prefers the DB-derived activeRunId when both are present and it's still in flight", () => {
    const out = resolveInflight({
      activeRunId: "run-active",
      activeTrigger: "chat",
      pendingRunId: "run-active",
      rows: [userRow("run-active")],
    });
    expect(out).toEqual({ show: true, runId: "run-active" });
  });

  it("falls back to pendingRunId when the (different) activeRunId already has a reply", () => {
    const out = resolveInflight({
      activeRunId: "run-old",
      activeTrigger: "chat",
      pendingRunId: "run-new",
      rows: [userRow("run-old"), assistantRow("run-old"), userRow(null)],
    });
    expect(out).toEqual({ show: true, runId: "run-new" });
  });
});

describe("isStreamDraftLive", () => {
  it("shows the draft while streaming", () => {
    expect(
      isStreamDraftLive({ runId: "r1", status: "streaming", rows: [userRow("r1")] }),
    ).toBe(true);
  });

  it("keeps the draft after complete until the reply row lands", () => {
    expect(
      isStreamDraftLive({ runId: "r1", status: "complete", rows: [userRow("r1")] }),
    ).toBe(true);
  });

  it("hides the draft once the reply row for the same run lands", () => {
    expect(
      isStreamDraftLive({
        runId: "r1",
        status: "complete",
        rows: [userRow("r1"), assistantRow("r1")],
      }),
    ).toBe(false);
  });

  it("ignores a reply row from a different run", () => {
    expect(
      isStreamDraftLive({
        runId: "r2",
        status: "complete",
        rows: [assistantRow("r1"), userRow("r2")],
      }),
    ).toBe(true);
  });

  it("hides the draft on failed or cancelled", () => {
    for (const status of ["failed", "cancelled", ""]) {
      expect(isStreamDraftLive({ runId: "r1", status, rows: [] })).toBe(false);
    }
  });

  it("hides the draft with no run id", () => {
    expect(isStreamDraftLive({ runId: null, status: "streaming", rows: [] })).toBe(false);
  });
});
