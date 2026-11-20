
export type CountableClient = { from: (table: string) => unknown };

type CountBuilder = {
  select: (
    columns: string,
    options: { count: "exact"; head: true },
  ) => {
    eq: (column: string, value: string) => PromiseLike<{ count: number | null; error: unknown }>;
  };
};

export const OPEN_CHANNEL_ACTIONS_VIEW = "customer_visible_open_channel_actions";

export async function countOpenChannelActions(
  sb: CountableClient,
  tenantId: string,
): Promise<number> {
  try {
    const { count, error } = await (sb.from(OPEN_CHANNEL_ACTIONS_VIEW) as CountBuilder)
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId);
    if (error) {
      console.warn(
        `[open-actions-count] ${tenantId}: ${
          (error as { message?: string }).message ?? String(error)
        }`,
      );
      return 0;
    }
    return count ?? 0;
  } catch (e) {
    console.warn(`[open-actions-count] ${tenantId}: ${(e as Error).message}`);
    return 0;
  }
}

export function totalWaitingOnYou(pendingDecisions: number | null, openChannelActions: number): number {
  return (pendingDecisions ?? 0) + openChannelActions;
}
