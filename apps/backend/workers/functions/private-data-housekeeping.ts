import { runConnectorTick } from "./db-connector-sweep";
import { runDataRetentionPurge, runDbRawResultsSweep } from "./transcript-retention-purge";
import { logEvent } from "@/services/logging/logEvent";

export type HousekeepingDeps = {
  connectorTick: () => Promise<unknown>;
  rawSweep: () => Promise<unknown>;
  dailyPurge: () => Promise<unknown>;
  log: typeof logEvent;
};
const DEFAULT: HousekeepingDeps = {
  connectorTick: () => runConnectorTick(),
  rawSweep: () => runDbRawResultsSweep(),
  dailyPurge: () => runDataRetentionPurge(),
  log: (i) => logEvent(i),
};

export function housekeepingSlots(now: Date): { connector: true; raw: boolean; daily: boolean } {
  const m = now.getUTCMinutes();
  return { connector: true, raw: m < 10, daily: now.getUTCHours() === 9 && m >= 40 && m < 50 };
}

export async function runPrivateDataHousekeeping(now: Date, deps: Partial<HousekeepingDeps> = {}): Promise<Record<string, "ok" | "failed" | "skipped">> {
  const d = { ...DEFAULT, ...deps };
  const slots = housekeepingSlots(now);
  const out: Record<string, "ok" | "failed" | "skipped"> = {};
  const run = async (name: string, due: boolean, fn: () => Promise<unknown>) => {
    if (!due) {
      out[name] = "skipped";
      return;
    }
    try {
      await fn();
      out[name] = "ok";
    } catch (e) {
      out[name] = "failed";
      await d.log({ level: "error", source: "private-data-housekeeping", code: `${name}_failed`, error: e });
    }
  };
  await run("connector_tick", slots.connector, d.connectorTick);
  await run("raw_results", slots.raw, d.rawSweep);
  await run("daily_retention", slots.daily, d.dailyPurge);
  return out;
}
