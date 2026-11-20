

import type { DashboardBuilder } from "./_contract";
import { getGeoMetrics } from "@/services/tools/growth/geo/panel";
import { listPrompts } from "@/services/tools/growth/geo/visibility/prompts";

export const build: DashboardBuilder = async ({ tenantId, meteredRefresh, rangeDays, requestedDays, customRange }) => {
  const [payload, prompts] = await Promise.all([
    getGeoMetrics(tenantId, { days: requestedDays ?? rangeDays, range: customRange ?? null, refresh: meteredRefresh }),
    listPrompts(tenantId).catch(() => null),
  ]);
  return {
    ...(payload as unknown as Record<string, unknown>),
    prompts,
  };
};
