import { describe, it, expect, vi } from "vitest";
vi.mock("../db-connector-sweep", () => ({ runConnectorTick: vi.fn() }));
vi.mock("../transcript-retention-purge", () => ({ runDataRetentionPurge: vi.fn(), runDbRawResultsSweep: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
import { housekeepingSlots, runPrivateDataHousekeeping } from "../private-data-housekeeping";

const at = (iso: string) => new Date(iso);

describe("private data housekeeping slots", () => {
  it("the connector sweep runs every tick; raw results once an hour; the daily purge once a day", () => {
    const ticks = Array.from({ length: 144 }, (_, i) => new Date(Date.UTC(2026, 9, 12, 0, i * 10)));
    const slots = ticks.map(housekeepingSlots);
    expect(slots.every((s) => s.connector)).toBe(true);
    expect(slots.filter((s) => s.raw)).toHaveLength(24);
    expect(slots.filter((s) => s.daily)).toHaveLength(1);
  });
  it("a failing step never stops the others", async () => {
    const connectorTick = vi.fn(async () => {
      throw new Error("down");
    });
    const rawSweep = vi.fn(async () => undefined);
    const dailyPurge = vi.fn(async () => undefined);
    const out = await runPrivateDataHousekeeping(at("2026-10-12T09:40:00Z"), { connectorTick, rawSweep, dailyPurge });
    expect(out).toEqual({ connector_tick: "failed", raw_results: "skipped", daily_retention: "ok" });
    const out2 = await runPrivateDataHousekeeping(at("2026-10-12T10:00:00Z"), { connectorTick, rawSweep, dailyPurge });
    expect(out2.raw_results).toBe("ok");
    expect(rawSweep).toHaveBeenCalledTimes(1);
  });
});
