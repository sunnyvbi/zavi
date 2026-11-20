import { inngest } from "../client";
import { fleetSweepClient } from "@/services/tenant-client";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import { processXOrganicTrial, deferXOrganicTrial, type XOrganicTrial } from "@/services/channels/x-organic-trials";

export async function runXOrganicTrials() {
  if (isWorkerCronStopped("x-organic-trials") || await isFleetHalted()) return { stopped: true };
  const { data, error } = await fleetSweepClient("advance due explicit X organic trials; tenant identity comes from each persisted trial, never an event")
    .from("x_organic_trials")
    .select("action_id,tenant_id,run_id,created_at,phase,receipts,proposal")
    .not("phase", "in", "(cancelled,expired,no_replies,proposed)").lte("next_check_at", new Date().toISOString())
    .order("next_check_at").limit(20);
  if (error) throw new Error("Could not read due X organic trials");
  let completed = 0, failed = 0;
  for (const trial of (data ?? []) as XOrganicTrial[]) {
    if (await isFleetHalted()) break;
    try { await processXOrganicTrial(trial); completed++; }
    catch {
      failed++;
      await deferXOrganicTrial(trial);
    }
  }
  return { completed, failed };
}

export const xOrganicTrialsFn = inngest.createFunction(
  { id: "x-organic-trials", retries: 0, concurrency: { limit: 1 } },
  { cron: "23 * * * *" },
  async ({ step }) => step.run("advance-trials", runXOrganicTrials),
);
