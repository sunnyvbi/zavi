
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";

export async function rollupAgentCsat(day?: string): Promise<{ rows: number }> {
  const { data, error } = await serviceClient().rpc(
    "rollup_agent_csat",
    day ? { p_day: day } : {},
  );
  if (error) throw new Error(`rollup_agent_csat failed: ${error.message}`);
  return { rows: typeof data === "number" ? data : 0 };
}

export const agentCsatRollupFn = inngest.createFunction(
  { id: "agent-csat-rollup" },
  { cron: "0 10 * * *" },
  async ({ logger }) => {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    let rows = 0;
    for (const d of [ymd(yesterday), ymd(today)]) {
      try {
        const r = await rollupAgentCsat(d);
        rows += r.rows;
      } catch (e) {
        logger.error(`agent-csat-rollup ${d} failed: ${(e as Error).message}`);
      }
    }
    logger.info(`agent-csat-rollup: upserted ${rows} per-agent rollup row(s)`);
    return { rows };
  },
);
