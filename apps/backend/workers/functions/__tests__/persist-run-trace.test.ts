
import { describe, it, expect } from "vitest";
import { assembleTraceJsonl } from "../persist-run-trace";

const baseRun = {
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  agent_slug: "engineer",
  trigger: "cron",
  status: "success",
  output_text: null,
  error: null,
  started_at: "2026-05-27T00:00:00Z",
  finished_at: "2026-05-27T00:00:10Z",
};

function evt(id: number, stage: string, created_at: string, meta: Record<string, unknown> = {}) {
  return { id, stage, meta, created_at };
}

describe("assembleTraceJsonl — count-match invariant", () => {
  it("emits exactly one `event` line per agent_run_events row (header + N)", () => {
    const events = [
      evt(1, "claimed", "2026-05-27T00:00:01Z"),
      evt(2, "tool_use_started", "2026-05-27T00:00:02Z", { tool_name: "github__read_file" }),
      evt(3, "tool_use_completed", "2026-05-27T00:00:03Z", { tool_name: "github__read_file", ms: 120 }),
      evt(4, "completed", "2026-05-27T00:00:04Z"),
    ];
    const { jsonl, eventCount, truncated } = assembleTraceJsonl(baseRun, events, []);
    const lines = jsonl.trimEnd().split("\n");
    const records = lines.map((l) => JSON.parse(l));

    expect(eventCount).toBe(4);
    expect(truncated).toBe(false);
    expect(records).toHaveLength(5);
    expect(records[0].kind).toBe("header");
    expect(records[0].event_count).toBe(4);
    expect(records[0].truncated).toBe(false);
    const eventRecords = records.slice(1);
    expect(eventRecords.every((r) => r.kind === "event")).toBe(true);
    expect(eventRecords).toHaveLength(events.length);
  });

  it("truncation: at the cap, truncated=true, event_count==persisted lines (NOT live total)", () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      evt(i + 1, "tool_use_completed", `2026-05-27T00:00:0${i}Z`),
    );
    const { jsonl, eventCount, truncated } = assembleTraceJsonl(baseRun, events, [], 3);
    const records = jsonl.trimEnd().split("\n").map((l) => JSON.parse(l));
    const eventLines = records.slice(1);

    expect(truncated).toBe(true);
    expect(eventCount).toBe(3);
    expect(eventLines).toHaveLength(3);
    expect(records[0].truncated).toBe(true);
    expect(records[0].event_count).toBe(3);
    expect(eventCount).toBe(eventLines.length);
  });

  it("not truncated when events below the cap", () => {
    const events = Array.from({ length: 3 }, (_, i) =>
      evt(i + 1, "completed", `2026-05-27T00:00:0${i}Z`),
    );
    const { eventCount, truncated } = assembleTraceJsonl(baseRun, events, [], 10);
    expect(truncated).toBe(false);
    expect(eventCount).toBe(3);
  });

  it("preserves agent_run_events order via seq + created_at", () => {
    const events = [
      evt(10, "claimed", "2026-05-27T00:00:01Z"),
      evt(20, "tool_use_started", "2026-05-27T00:00:02Z"),
      evt(30, "completed", "2026-05-27T00:00:03Z"),
    ];
    const { jsonl } = assembleTraceJsonl(baseRun, events, []);
    const eventRecords = jsonl.trimEnd().split("\n").slice(1).map((l) => JSON.parse(l));
    expect(eventRecords.map((r) => r.seq)).toEqual([10, 20, 30]);
    expect(eventRecords.map((r) => r.stage)).toEqual([
      "claimed",
      "tool_use_started",
      "completed",
    ]);
  });

  it("zero events → header only, event_count 0", () => {
    const { jsonl, eventCount } = assembleTraceJsonl(baseRun, [], []);
    const records = jsonl.trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(eventCount).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe("header");
    expect(records[0].event_count).toBe(0);
  });

  it("passes agent_run_events.meta through verbatim (already C14-whitelisted at source)", () => {
    const events = [evt(1, "tool_use_completed", "2026-05-27T00:00:03Z", { tool_name: "x", ms: 5, iter: 2 })];
    const { jsonl } = assembleTraceJsonl(baseRun, events, []);
    const ev = JSON.parse(jsonl.trimEnd().split("\n")[1]);
    expect(ev.meta).toEqual({ tool_name: "x", ms: 5, iter: 2 });
  });
});

describe("assembleTraceJsonl — C14 redaction of free text", () => {
  it("redacts PII in output_text + error before they hit the blob", () => {
    const run = {
      ...baseRun,
      status: "failed",
      output_text: "contact the host at jane.doe@example.com or 415-555-0199",
      error: "failed reaching admin@secret.io",
    };
    const { jsonl } = assembleTraceJsonl(run, [], []);
    const header = JSON.parse(jsonl.trimEnd().split("\n")[0]);

    expect(header.output_text).not.toContain("jane.doe@example.com");
    expect(header.output_text).not.toContain("415-555-0199");
    expect(header.output_text).toContain("‹redacted:email›");
    expect(header.output_text).toContain("‹redacted:phone›");

    expect(header.error).not.toContain("admin@secret.io");
    expect(header.error).toContain("‹redacted:email›");
  });

  it("redacts PII in reasoning text", () => {
    const reasoning = [
      { body: { text: "the operator emailed me at ceo@acme.com", iter: 1 }, created_at: "2026-05-27T00:00:02Z" },
    ];
    const { jsonl } = assembleTraceJsonl(baseRun, [], reasoning);
    const header = JSON.parse(jsonl.trimEnd().split("\n")[0]);
    expect(header.reasoning[0].text).not.toContain("ceo@acme.com");
    expect(header.reasoning[0].text).toContain("‹redacted:email›");
    expect(header.reasoning[0].iter).toBe(1);
  });

  it("null output_text / error → null (not the string 'null')", () => {
    const { jsonl } = assembleTraceJsonl(baseRun, [], []);
    const header = JSON.parse(jsonl.trimEnd().split("\n")[0]);
    expect(header.output_text).toBeNull();
    expect(header.error).toBeNull();
  });

  it("redacts BEFORE truncating — PII near the length cap is still scrubbed (codex round-6 P2)", () => {
    const filler = "x".repeat(25_000);
    const run = {
      ...baseRun,
      output_text: `${filler} secret contact: leak@evil.com`,
    };
    const { jsonl } = assembleTraceJsonl(run, [], []);
    expect(jsonl).not.toContain("leak@evil.com");
  });
});
