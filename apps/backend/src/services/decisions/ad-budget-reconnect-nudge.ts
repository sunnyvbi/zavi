
import { inngest } from "@/../workers/client";

export function nudgeAdBudgetReadAfterReconnect(tenant_id: string): void {
  const minute = new Date().toISOString().slice(0, 16);
  try {
    void Promise.resolve(
      inngest.send({
        id: `ad_budget.reconnect_read:${tenant_id}:${minute}`,
        name: "ad_budget.reconnect_read.requested",
        data: { tenant_id },
      }),
    ).catch(() => {});
  } catch {
  }
}
