import type { OperatorDbType, RawIntrospection } from "@/services/tools/operator-db/types";
import { DEFAULT_TABLE_CAP } from "@/services/tools/operator-db/discovery/util";
import { sanitizeDiscoveryError } from "@/services/tools/operator-db/discovery/errors";
import { noTlsMessage } from "../direct/tls";
import {
  DEFAULT_CAP_MS,
  persistIntrospection,
  persistDiscoveryError,
  type DiscoverResult,
} from "@/services/tools/operator-db/discovery";
import { introspectPostgres } from "./postgres";
import { introspectMysql } from "./mysql";
import { introspectMongo } from "./mongo";
import { introspectDynamodb } from "./dynamodb";

export function introspect(
  type: OperatorDbType,
  conn: string,
  deadlineMs: number,
  tableCap: number = DEFAULT_TABLE_CAP,
): Promise<RawIntrospection> {
  if (type === "postgres") return introspectPostgres(conn, tableCap, deadlineMs);
  if (type === "mysql") return introspectMysql(conn, tableCap, deadlineMs);
  if (type === "dynamodb") return introspectDynamodb(conn, tableCap, deadlineMs);
  return introspectMongo(conn, tableCap, deadlineMs);
}

export async function probeConnectivity(
  type: OperatorDbType,
  connectionString: string,
  capMs = 10_000,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const deadline = Date.now() + capMs;
  try {
    await Promise.race([
      introspect(type, connectionString, deadline, 0),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("connectivity probe timed out")), capMs + 1000),
      ),
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: noTlsMessage(type, e, connectionString) ?? sanitizeDiscoveryError(e) };
  }
}

export async function discoverWithConnection(
  tenantId: string,
  type: OperatorDbType,
  connectionString: string,
  opts: { capMs?: number; tableCap?: number; generation: number },
): Promise<DiscoverResult> {
  const capMs = opts.capMs ?? DEFAULT_CAP_MS;
  const tableCap = opts.tableCap ?? DEFAULT_TABLE_CAP;
  const deadline = Date.now() + capMs;
  try {
    const raw = await Promise.race([
      introspect(type, connectionString, deadline, tableCap),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("discovery timed out")), capMs + 2000)),
    ]);
    return await persistIntrospection(tenantId, type, raw, deadline, opts.generation);
  } catch (e) {
    return persistDiscoveryError(tenantId, type, e, opts.generation);
  }
}
