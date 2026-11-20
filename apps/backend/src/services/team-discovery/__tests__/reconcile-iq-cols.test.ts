
import { describe, it, expect } from "vitest";
import {
  buildIqExtraColumns,
  type SlackIqExtraColumns,
} from "../reconcile";

describe("buildIqExtraColumns . Slack-IQ W1 P1 conditional-write helper", () => {
  it("(a) returns empty object on undefined input", () => {
    const out = buildIqExtraColumns(undefined);
    expect(out).toEqual({});
  });

  it("(b) returns empty object on empty input (no keys to spread)", () => {
    const out = buildIqExtraColumns({});
    expect(out).toEqual({});
  });

  it("(c) includes only the keys present in input . last_active_at alone", () => {
    const out = buildIqExtraColumns({
      last_active_at: "2026-05-26T00:00:00Z",
    });
    expect(out).toEqual({ last_active_at: "2026-05-26T00:00:00Z" });
    expect(Object.keys(out).sort()).toEqual(["last_active_at"]);
  });

  it("(d) caps active_channels at 20 entries (Codex P2.11 bound)", () => {
    const ac = Array.from({ length: 25 }, (_, i) => `C${i + 1}`);
    const out = buildIqExtraColumns({ active_channels: ac });
    expect(Array.isArray(out.active_channels)).toBe(true);
    expect((out.active_channels as string[]).length).toBe(20);
    expect((out.active_channels as string[])[0]).toBe("C1");
    expect((out.active_channels as string[])[19]).toBe("C20");
  });

  it("(e) writes NULL explicitly when caller passes null (clobbers existing)", () => {
    const out = buildIqExtraColumns({ slack_iq_role: null });
    expect("slack_iq_role" in out).toBe(true);
    expect(out.slack_iq_role).toBeNull();
  });

  it("(f) all 5 columns supplied → all 5 present in output", () => {
    const all: SlackIqExtraColumns = {
      slack_iq_role: "engineer",
      owned_areas: ["billing", "auth"],
      active_channels: ["C1", "C2"],
      last_active_at: "2026-05-26T00:00:00Z",
      expertise_summary: "TS + Postgres",
    };
    const out = buildIqExtraColumns(all);
    expect(Object.keys(out).sort()).toEqual([
      "active_channels",
      "expertise_summary",
      "last_active_at",
      "owned_areas",
      "slack_iq_role",
    ]);
    expect(out.slack_iq_role).toBe("engineer");
    expect(out.owned_areas).toEqual(["billing", "auth"]);
    expect(out.active_channels).toEqual(["C1", "C2"]);
    expect(out.last_active_at).toBe("2026-05-26T00:00:00Z");
    expect(out.expertise_summary).toBe("TS + Postgres");
  });

  it("active_channels null stays null (does not coerce to '[]')", () => {
    const out = buildIqExtraColumns({ active_channels: null });
    expect("active_channels" in out).toBe(true);
    expect(out.active_channels).toBeNull();
  });

  it("owned_areas null stays null", () => {
    const out = buildIqExtraColumns({ owned_areas: null });
    expect("owned_areas" in out).toBe(true);
    expect(out.owned_areas).toBeNull();
  });

  it("expertise_summary undefined-by-omission is OMITTED (preserves operator edit)", () => {
    const out = buildIqExtraColumns({ last_active_at: "2026-05-26T00:00:00Z" });
    expect("expertise_summary" in out).toBe(false);
  });
});
