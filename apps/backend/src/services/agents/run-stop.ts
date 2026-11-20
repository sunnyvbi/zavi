
import { serviceClient } from "../supabase";

export async function isRunStopRequested(run_id: string): Promise<boolean> {
  try {
    const { data, error } = await serviceClient()
      .from("agent_runs")
      .select("stop_requested")
      .eq("id", run_id)
      .maybeSingle();
    if (error) {
      console.warn(
        `[run-stop] isRunStopRequested lookup failed for ${run_id}: ${error.message}`,
      );
      return false;
    }
    return data?.stop_requested === true;
  } catch (e) {
    console.warn(
      `[run-stop] isRunStopRequested threw for ${run_id}: ${(e as Error).message}`,
    );
    return false;
  }
}
