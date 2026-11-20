import { describe, it, expect, beforeEach } from "vitest";
import { chatReadMeta, noteNotConnected, noteRefusal, noteOffline, peekRunNotes, takeRunNotes, _resetRunNotes, MAX_RUNS } from "../run-reads";
import { collectAccessNotes, pushAccessNote } from "../note-collector";

beforeEach(() => _resetRunNotes());

describe("run read notes", () => {
  it("records and takes notes per run", () => {
    noteRefusal("r1", "zavi", "users.email is hidden", ["users"]);
    noteOffline("r1", "mac-mini");
    noteRefusal(null, "zavi", "ignored", []);
    expect(peekRunNotes("r1")).toHaveLength(2);
    expect(takeRunNotes("r1")).toHaveLength(2);
    expect(peekRunNotes("r1")).toEqual([]);
  });
  it("evicts beyond MAX_RUNS runs (oldest first)", () => {
    for (let i = 0; i <= MAX_RUNS; i++) noteOffline(`r${i}`, null);
    expect(peekRunNotes("r0")).toEqual([]);
    expect(peekRunNotes(`r${MAX_RUNS}`)).toHaveLength(1);
  });
});

describe("chat card meta", () => {
  it("carries the latest offline machine and last-seen time, and not-connected, then clears", () => {
    noteOffline("r2", "old-box", "2026-10-11T10:00:00Z");
    noteRefusal("r2", "connector", "x", ["users"]);
    noteOffline("r2", "mac-mini", "2026-10-11T12:00:00Z");
    noteNotConnected("r2");
    expect(chatReadMeta("r2")).toEqual({
      connector_offline: { machine: "mac-mini", last_seen_at: "2026-10-11T12:00:00Z" },
      db_not_connected: true,
    });
    expect(chatReadMeta("r2")).toEqual({});
  });
  it("a run that read normally carries nothing", () => {
    noteRefusal("r3", "zavi", "x", []);
    expect(chatReadMeta("r3")).toEqual({});
    expect(chatReadMeta(null)).toEqual({});
  });
});

describe("access note collector", () => {
  it("collects notes pushed inside the call only", async () => {
    pushAccessNote({ log_id: "outside", mode: "direct", tables: [], rows: 0, result: "allowed" });
    const { result, notes } = await collectAccessNotes(async () => {
      pushAccessNote({ log_id: "a", mode: "direct", tables: ["users"], rows: 2, result: "allowed" });
      await Promise.resolve();
      pushAccessNote({ log_id: "b", mode: "direct", tables: ["users"], rows: 0, result: "refused", refused_by: "zavi" });
      return 7;
    });
    expect(result).toBe(7);
    expect(notes.map((n) => n.log_id)).toEqual(["a", "b"]);
  });
});
