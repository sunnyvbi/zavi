import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { inngest } from "@/../workers/client";

export type DiscoveryDeps = {
  send: (e: { id: string; name: "operator-db.discover.requested"; data: { tenant_id: string } }) => Promise<unknown>;
  rpc: typeof tenantRpc;
  log: typeof logEvent;
};
const DEFAULT: DiscoveryDeps = {
  send: (e) => inngest.send(e),
  rpc: (...a) => tenantRpc(...a),
  log: (i) => logEvent(i),
};

export const discoveryEventId = (tenant_id: string, generation: number | string) => `dbc-discover-${tenant_id}-${generation}`;

export async function sendConnectorDiscovery(tenant_id: string, generation: number, deps: Partial<DiscoveryDeps> = {}): Promise<boolean> {
  const d = { ...DEFAULT, ...deps };
  try {
    await d.send({ id: discoveryEventId(tenant_id, generation), name: "operator-db.discover.requested", data: { tenant_id } });
  } catch (e) {
    await d.log({ level: "error", source: "db-connector.discovery", code: "connector_discover_enqueue_failed", tenant_id, error: e });
    return false;
  }
  try {
    const { error } = await d.rpc(asTenantId(tenant_id), "ack_db_connector_discovery", { p_generation: generation });
    if (error) throw new Error(error.message);
  } catch (e) {
    await d.log({ level: "warn", source: "db-connector.discovery", code: "connector_discover_ack_failed", tenant_id, error: e });
  }
  return true;
}
