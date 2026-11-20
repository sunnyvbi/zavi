
import type { GrowthGoalAttention } from "@/../workers/client";
import { syncGoalWork } from "./goal-owner";

export async function sendGoalAttention(data: GrowthGoalAttention["data"]): Promise<void> {
  if (data.reason === "goal_set" && data.goal_id) await syncGoalWork(data.tenant_id, data.goal_id);
  try {
    const { inngest } = await import("@/../workers/client");
    await inngest.send({ name: "growth/goal.attention", data });
  } catch (e) {
    console.warn(`[goal-attention] send failed (${data.reason}, tenant ${data.tenant_id}): ${(e as Error).message}`);
  }
}
