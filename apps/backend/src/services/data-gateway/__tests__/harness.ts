import { effectivePolicy, type CatalogLike } from "@zavi/shared/db-guard";
import { loggedSession } from "../logged-session";
import { fakeSession } from "./fake-session";
import type { DbAccess } from "../resolve";
import type { GatewayContext } from "../types";
import type { ReadSession } from "../session";
import { attachSession } from "@/services/tools/operator-db/session-attach";
import type { OperatorDbDriver, SchemaMap } from "@/services/tools/operator-db/types";

export function gatewayHarness(opts: {
  dialect: DbAccess["dialect"];
  catalog: CatalogLike;
  hidden?: string[];
  disabled?: string[];
  rows?: Record<string, unknown>[];
  docs?: Record<string, unknown>[];
  schema_map?: Record<string, unknown>;
}) {
  const fake = fakeSession({ dialect: opts.dialect, rows: opts.rows, docs: opts.docs });
  const policy = effectivePolicy(
    { auto_hide: false, hidden_fields: opts.hidden ?? [], unhidden_fields: [], disabled_tables: opts.disabled ?? [] },
    opts.catalog,
    opts.dialect,
  );
  const access = {
    tenant_id: "t1",
    mode: "direct",
    dialect: opts.dialect,
    config: { type: opts.dialect, connection_secret_key: "k", schema_map: opts.schema_map ?? {} },
    catalog: { dialect: opts.dialect, catalog: opts.catalog, hints: {}, catalog_hash: "h", coverage: null, discovery_error: null, updated_at: null },
    policy,
    connectionString: "x://y",
    database: null,
  } as unknown as DbAccess;
  const contexts: GatewayContext[] = [];
  const open = (ctx: GatewayContext): ReadSession => {
    contexts.push(ctx);
    return loggedSession(fake.session, access, ctx);
  };
  return {
    fake,
    access,
    contexts,
    withReadSession: async <T>(ctx: GatewayContext, fn: (s: ReadSession, a: DbAccess) => Promise<T>) => fn(open(ctx), access),
    resolveAttachedDb: async (ctx: GatewayContext, driverFactory: () => OperatorDbDriver) => {
      const session = open(ctx);
      const cfg = attachSession({ ...(access.config.schema_map as SchemaMap) }, session);
      return { driver: driverFactory(), cfg, access, close: async () => undefined };
    },
  };
}
