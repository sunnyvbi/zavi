
import { inngest } from "../client";
import {
  discoverCatalogForTenant,
  OPERATOR_DB_DISCOVER_FOR_TENANT_C8reverified,
} from "@/services/tools/operator-db/discovery/run-for-tenant";
import { autoConfirmManagedMapping } from "@/services/tools/operator-db/zavi-auto-confirm";
import { carryForwardConfirmedMapping } from "@/services/tools/operator-db/mapping-carry-forward";
import {
  WORKER_DISCOVER_CAP_MS,
  WORKER_DISCOVER_TABLE_CAP,
} from "@/services/tools/operator-db/discovery";

export const OPERATOR_DB_DISCOVER_TENANT_C8reverified =
  OPERATOR_DB_DISCOVER_FOR_TENANT_C8reverified;

export const operatorDbDiscoverFn = inngest.createFunction(
  {
    id: "operator-db-discover",
    concurrency: [{ limit: 4 }, { key: "event.data.tenant_id", limit: 1 }],
    retries: 2,
  },
  { event: "operator-db.discover.requested" },
  async ({ event, logger }) => {
    const tenant_id = event.data.tenant_id;
    if (!tenant_id || typeof tenant_id !== "string") {
      logger.warn("operator-db-discover: missing tenant_id in event");
      return { outcome: "no_tenant" };
    }

    const generation = typeof event.data.generation === "number" ? event.data.generation : null;
    const result = await discoverCatalogForTenant(tenant_id, {
      capMs: WORKER_DISCOVER_CAP_MS,
      tableCap: WORKER_DISCOVER_TABLE_CAP,
      generation,
    });

    if (result.ok) {
      logger.info(
        `operator-db-discover: tenant=${tenant_id} tables_found=${result.tables_found}`,
      );
      try {
        const confirm = await autoConfirmManagedMapping(tenant_id);
        logger.info(`operator-db-discover: tenant=${tenant_id} zavi-auto-confirm=${confirm}`);
      } catch (e) {
        logger.warn(`operator-db-discover: auto-confirm failed: ${(e as Error).message}`);
      }
      try {
        const carried = await carryForwardConfirmedMapping(tenant_id);
        logger.info(`operator-db-discover: tenant=${tenant_id} mapping-carry-forward=${carried}`);
      } catch (e) {
        logger.warn(`operator-db-discover: mapping carry-forward failed: ${(e as Error).message}`);
      }
      try {
        await inngest.send({ name: "marketplace.rollup.requested", data: { tenant_id } });
      } catch (e) {
        logger.warn(`operator-db-discover: rollup enqueue failed: ${(e as Error).message}`);
      }
      return { outcome: "discovered", tables_found: result.tables_found };
    }
    logger.warn(
      `operator-db-discover: tenant=${tenant_id} failed=${result.discovery_error}`,
    );
    return { outcome: "error", discovery_error: result.discovery_error };
  },
);
