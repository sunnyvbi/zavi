
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { liveSessionTab } from "@/services/extension/browser-ops";

export const EXTENSION_PANEL_PAYLOAD_KEY = "extension_panel";

export type PanelBinding = {
  panel_session_id: string;
  tab_id: number;
  user_id: string;
};

export async function bindRunToPanelSession(args: {
  tenant_id: string;
  user_id: string;
  run_id: string;
  panel_session_id: string;
}): Promise<boolean> {
  const tab_id = await liveSessionTab(args.panel_session_id, args.tenant_id, args.user_id).catch(() => null);
  if (tab_id === null) return false;

  const runs = tenantClient(asTenantId(args.tenant_id));
  const { data: row, error: readErr } = await runs
    .from("agent_runs")
    .select("payload")
    .eq("id", args.run_id)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (!row) return false;
  const payload = ((row as { payload?: unknown }).payload ?? {}) as Record<string, unknown>;

  const { error } = await runs
    .from("agent_runs")
    .update({
      actor_user_id: args.user_id,
      actor_source: "chat",
      payload: {
        ...payload,
        [EXTENSION_PANEL_PAYLOAD_KEY]: { panel_session_id: args.panel_session_id, tab_id },
      },
    })
    .eq("id", args.run_id);
  if (error) throw new Error(error.message);
  return true;
}

export async function readRunPanelBinding(tenant_id: string, run_id: string): Promise<PanelBinding | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("payload, actor_user_id, enqueued_by")
    .eq("id", run_id)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { payload?: unknown; actor_user_id?: unknown; enqueued_by?: unknown };
  const actor = typeof row.actor_user_id === "string" && row.actor_user_id ? row.actor_user_id : null;
  if (!actor || row.enqueued_by !== actor) return null;
  const b = ((row.payload ?? {}) as Record<string, unknown>)[EXTENSION_PANEL_PAYLOAD_KEY] as
    | { panel_session_id?: unknown; tab_id?: unknown }
    | undefined;
  if (!b || typeof b.panel_session_id !== "string" || !Number.isInteger(b.tab_id)) return null;
  return { panel_session_id: b.panel_session_id, tab_id: b.tab_id as number, user_id: actor };
}
