
import { inngest } from "../client";
import { fleetSweepClient } from "@/services/tenant-client";
import {
  METRICS_ROW_COLUMNS,
  isDue,
  readbackAssetMetrics,
  type LibraryMetricsRow,
  type ReadbackOutcome,
} from "@/services/creators/library-metrics";

export const SWEEP_LIMIT = 25;

export const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

export type SweepResult = {
  scanned: number;
  read: number;
  written: number;
  skipped: number;
};

export async function runLibraryMetricsSweepHandler(logger: {
  info: (m: string) => void;
  error?: (m: string) => void;
}): Promise<SweepResult> {
  const sb = fleetSweepClient("creator library ad-metrics sweep");
  const { data, error } = await sb
    .from("creator_library_assets")
    .select(METRICS_ROW_COLUMNS)
    .not("meta_ad_id", "is", null)
    .not("meta_ad_set_id", "is", null)
    .order("metrics_read_at", { ascending: true, nullsFirst: true })
    .limit(SWEEP_LIMIT * 4);

  if (error) {
    logger.error?.(`creator-library-metrics sweep: read failed — ${error.message}`);
    return { scanned: 0, read: 0, written: 0, skipped: 0 };
  }

  const rows = (data ?? []) as unknown as LibraryMetricsRow[];
  const due = rows.filter((r) => isDue(r, STALE_AFTER_MS)).slice(0, SWEEP_LIMIT);

  let written = 0;
  let skipped = 0;
  const outcomes: Record<string, number> = {};
  for (const row of due) {
    const { outcome } = await readbackAssetMetrics(row);
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    if (outcome === "written") written += 1;
    else skipped += 1;
  }

  if (due.length > 0) {
    const detail = Object.entries(outcomes)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    logger.info(
      `creator-library-metrics sweep: scanned=${rows.length} read=${due.length} ${detail}`,
    );
  }
  return { scanned: rows.length, read: due.length, written, skipped };
}

export type { ReadbackOutcome };

export const creatorLibraryMetricsSweepFn = inngest.createFunction(
  { id: "creator-library-metrics-sweep", concurrency: 1 },
  { cron: "0 */4 * * *" },
  async ({ logger }) => runLibraryMetricsSweepHandler(logger),
);
