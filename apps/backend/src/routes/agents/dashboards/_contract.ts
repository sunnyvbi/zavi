
import type { ToolContext } from "@/services/tools/types";
import type { serverClientFromBearer } from "@/services/supabase";

export type ServerClient = ReturnType<typeof serverClientFromBearer>;

export type DashboardContext = {
  tenantId: string;
  accessToken: string;
  ctx: ToolContext;
  sb: ServerClient;
  refresh: boolean;
  meteredRefresh: boolean;
  rangeDays: number | null;
  requestedDays?: number | null;
  customRange?: { since: string; until: string } | null;
};

export type DashboardBuilder = (
  c: DashboardContext,
) => Promise<Record<string, unknown>>;
