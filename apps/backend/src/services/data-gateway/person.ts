import { checkReadOnly, sourceFor } from "@zavi/shared/db-guard";
import { ExpectedToolError } from "@/services/tools/types";
import { loadDbAccess, type DbAccess } from "./resolve";
import { openSqlSession } from "./direct/sql";
import { openMongoSession } from "./direct/mongo";
import { reserveAudit, finalizeAudit, writeRefusalAudit } from "./audit";
import { GatewayRefusal, type GatewayContext } from "./types";
import { openConnectorSession } from "./connector/session";
import { failureReason } from "./logged-session";
import type { ReadSession } from "./session";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ContactImportContext = GatewayContext & {
  caller: { kind: "person"; user_id: string; feature: "Contact import" };
};

export async function listContactImportTables(ctx: ContactImportContext): Promise<Array<{ name: string; columns: Array<{ name: string; type: string }> }>> {
  const access = await loadDbAccess(ctx.tenant_id, { withSecret: false });
  return access.catalog.catalog.tables
    .filter((t) => access.policy.resolve(t.name, true) !== null)
    .map((t) => ({ name: t.name, columns: (t.columns ?? []).map((c) => ({ name: c.name, type: c.type })) }));
}

async function open(access: DbAccess, ctx: GatewayContext): Promise<ReadSession> {
  if (access.mode === "connector") return openConnectorSession(ctx, access.dialect);
  if (access.dialect === "postgres" || access.dialect === "mysql") return openSqlSession(access.dialect, access.connectionString!);
  if (access.dialect === "mongodb") return openMongoSession(access.connectionString!);
  throw new ExpectedToolError("operator_db_unsupported_dialect", "Importing from this kind of database is not supported yet.");
}

export async function readContactColumn(
  ctx: ContactImportContext,
  table: string,
  field: string,
  limit: number,
): Promise<{ values: unknown[]; truncated: boolean; dialect: string; table: string; field: string }> {
  const access = await loadDbAccess(ctx.tenant_id);
  const t = access.policy.resolve(table, true);
  if (!t) {
    await writeRefusalAudit({ ctx, mode: access.mode, dialect: access.dialect, operation: "read", query_text: `Contact import: ${table}.${field}`, tables: [table], refused_by: "zavi", reason: `${table} is not a table Zavi may read.` });
    throw new ExpectedToolError("data_access_refused", `Refused by a data-access rule: ${table} is not a table Zavi may read.`);
  }
  const col = (t.columns ?? []).find((c) => c.name === field);
  if (!col || !IDENT.test(t.name) || !IDENT.test(col.name)) {
    throw new ExpectedToolError("operator_db_bad_field", "That column cannot be imported.");
  }
  const max = Math.max(1, Math.floor(limit));
  const q = (n: string) => (access.dialect === "mysql" ? "`" + n.replace(/`/g, "``") + "`" : `"${n.replace(/"/g, '""')}"`);
  const src = sourceFor(t.name, access.policy, access.dialect === "mysql" ? "mysql" : "postgres", access.database ?? null);
  if (typeof src !== "string") throw new ExpectedToolError("data_access_refused", `Refused by a data-access rule: ${src.reason}`);
  const sql = `SELECT ${q(col.name)} FROM ${src} WHERE ${q(col.name)} IS NOT NULL LIMIT ${max + 1}`;
  const queryText = access.dialect === "mongodb" ? `find ${t.name} {"${col.name}":{"$type":"string"}} projection {"${col.name}":1} sort {"_id":1}` : sql;

  const session = await open(access, ctx);
  const id = await reserveAudit({ ctx, mode: access.mode, dialect: access.dialect, operation: "read", query_text: queryText, tables: [t.name] }).catch(async (e) => {
    await session.close().catch(() => undefined);
    throw e;
  });
  const t0 = Date.now();
  try {
    let values: unknown[];
    if (access.dialect === "mongodb") {
      const docs = await session.mongo().find(t.name, { [col.name]: { $type: "string" } }, { projection: { [col.name]: 1, _id: 0 }, sort: { _id: 1 }, limit: max + 1 });
      values = docs.map((d) => (d as Record<string, unknown>)[col.name]);
    } else {
      const ro = checkReadOnly(sql, access.dialect as "postgres" | "mysql");
      if (!ro.ok) throw new ExpectedToolError(ro.code, ro.reason);
      values = (await session.query(sql, [], { maxRows: max + 1 })).rows.map((r) => r[col.name] ?? Object.values(r)[0]);
    }
    const truncated = values.length > max;
    if (truncated) values = values.slice(0, max);
    await finalizeAudit(id, ctx, { result: "allowed", row_count: values.length, ms: Date.now() - t0 });
    return { values, truncated, dialect: access.dialect, table: t.name, field: col.name };
  } catch (e) {
    if (e instanceof GatewayRefusal && e.refused_by === "connector") {
      await finalizeAudit(id, ctx, { result: "refused", row_count: 0, refused_by: "connector", reason: e.reason, ms: Date.now() - t0 });
      throw e;
    }
    await finalizeAudit(id, ctx, { result: "failed", row_count: 0, reason: failureReason(e), ms: Date.now() - t0 });
    throw e;
  } finally {
    await session.close().catch(() => undefined);
  }
}
