import { effectivePolicy } from "@zavi/shared/db-guard";
import { openSqlSession } from "@/services/data-gateway/direct/sql";
import { loggedSession } from "@/services/data-gateway/logged-session";
import { introspectPostgres } from "@/services/data-gateway/discovery/postgres";
import { introspectMysql } from "@/services/data-gateway/discovery/mysql";
import { introspectMongo } from "@/services/data-gateway/discovery/mongo";
import { openMongoSession } from "@/services/data-gateway/direct/mongo";
import { mongoDbAdapter } from "@/services/tools/operator-db/session-attach";
import type { MarketplaceIntelMongoDb } from "../aggregate";
import { normalizeRawCatalog } from "@/services/tools/operator-db/discovery";
import type { DbAccess } from "@/services/data-gateway/resolve";
import type { ReadSession } from "@/services/data-gateway/session";

const ctx = { tenant_id: "live", caller: { kind: "agent" as const, agent_slug: "live", run_id: null, tool_name: "live" } };

export async function openLiveSession(dialect: "postgres" | "mysql", url: string): Promise<ReadSession> {
  const raw = dialect === "postgres" ? await introspectPostgres(url) : await introspectMysql(url);
  const catalog = normalizeRawCatalog(raw);
  const access = {
    tenant_id: "live",
    mode: "direct",
    dialect,
    database: null,
    policy: effectivePolicy({ auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, catalog, dialect),
  } as unknown as DbAccess;
  return loggedSession(await openSqlSession(dialect, url), access, ctx);
}

export async function openLiveMongoDb(url: string): Promise<{ db: MarketplaceIntelMongoDb; close: () => Promise<void> }> {
  const catalog = normalizeRawCatalog(await introspectMongo(url));
  const access = {
    tenant_id: "live",
    mode: "direct",
    dialect: "mongodb",
    database: null,
    policy: effectivePolicy({ auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, catalog, "mongodb"),
  } as unknown as DbAccess;
  const session = loggedSession(await openMongoSession(url), access, ctx);
  return { db: mongoDbAdapter(session.mongo()) as unknown as MarketplaceIntelMongoDb, close: () => session.close() };
}
