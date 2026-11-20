
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { writeMemorySignal } from "@/services/memory/write-signal";

const SETTLE_MINUTES = 10;
const LOOKBACK_DAYS = 14;
const PAGE_SIZE = 500;
const TERMINAL = ["success", "parse_failed", "dispatch_error", "failed"];

type RunRow = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  trigger: string;
  status: string;
  error: string | null;
  parse_error: string | null;
  output_text: string | null;
  cost_usd: number | null;
  started_at: string | null;
  finished_at: string | null;
  payload: unknown;
  tool_calls: unknown;
};

async function backfill(): Promise<{ scanned: number; written: number }> {
  const sb = serviceClient();
  const cutoff = new Date(Date.now() - SETTLE_MINUTES * 60_000).toISOString();
  const lookback = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  const { data: runs, error } = await sb
    .from("agent_runs")
    .select(
      "id, tenant_id, agent_slug, trigger, status, error, parse_error, output_text, cost_usd, started_at, finished_at, payload, tool_calls",
    )
    .in("status", TERMINAL)
    .lt("finished_at", cutoff)
    .gte("finished_at", lookback)
    .order("finished_at", { ascending: true })
    .limit(PAGE_SIZE);
  if (error) {
    console.warn(`[memory-signal-backfill] agent_runs scan failed: ${error.message}`);
    return { scanned: 0, written: 0 };
  }
  const rows = (runs ?? []) as RunRow[];
  if (rows.length === 0) return { scanned: 0, written: 0 };

  const ids = rows.map((r) => r.id);
  const { data: existing, error: exErr } = await sb
    .from("memory_signal")
    .select("agent_run_id")
    .in("agent_run_id", ids)
    .eq("signal_kind", "episode");
  if (exErr) {
    console.warn(`[memory-signal-backfill] memory_signal scan failed: ${exErr.message}`);
    return { scanned: rows.length, written: 0 };
  }
  const have = new Set((existing ?? []).map((e) => (e as { agent_run_id: string }).agent_run_id));

  let written = 0;
  for (const r of rows) {
    if (have.has(r.id)) continue;
    try {
      await writeMemorySignal({
        run_id: r.id,
        row: {
          agent_slug: r.agent_slug,
          tenant_id: r.tenant_id,
          trigger: r.trigger,
          started_at: r.started_at,
          finished_at: r.finished_at,
          payload: r.payload,
        },
        update: {
          status: r.status,
          error: r.error,
          parse_error: r.parse_error,
          output_text: r.output_text,
          cost_usd: r.cost_usd,
          tool_calls: r.tool_calls,
        },
        captureSource: "backfill",
      });
      written += 1;
    } catch (e) {
      console.warn(`[memory-signal-backfill] write for ${r.id} failed: ${(e as Error).message}`);
    }
  }
  return { scanned: rows.length, written };
}

export const memorySignalBackfillFn = inngest.createFunction(
  { id: "memory-signal-backfill", concurrency: 1 },
  { cron: "17 * * * *" },
  async ({ logger }) => {
    const res = await backfill();
    logger.info(`memory-signal-backfill: scanned=${res.scanned} written=${res.written}`);
    return res;
  },
);
