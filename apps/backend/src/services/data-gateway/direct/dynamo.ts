import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { isSensitiveField, normalizePath, type Policy } from "@zavi/shared/db-guard";
import { ExpectedToolError } from "@/services/tools/types";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { parseDynamodbUri, type ParsedDynamodbUri } from "@/services/tools/operator-db/dynamodb-uri";
import type { DynamoFacade, DynamoFilter, DynamoQueryInput, DynamoScanInput, ReadSession } from "../session";
import { GatewayRefusal } from "../types";

export function makeDynamoClient(parsed: ParsedDynamodbUri): DynamoDBClient {
  return new DynamoDBClient({
    region: parsed.region,
    credentials: {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
      sessionToken: parsed.sessionToken,
    },
    endpoint: parsed.endpoint,
    requestHandler: undefined,
  });
}

export const MAX_DYNAMO_ITEMS = 1000;
const REQUEST_TIMEOUT_MS = 8_000;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,254}$/;

type DocSend = { send(cmd: unknown): Promise<{ Items?: Record<string, unknown>[] }> };

function projection(fields: string[] | undefined): { ProjectionExpression?: string; ExpressionAttributeNames?: Record<string, string> } {
  if (!fields || fields.length === 0) return {};
  const names: Record<string, string> = {};
  const parts = fields.map((f, i) => {
    names[`#f${i}`] = f;
    return `#f${i}`;
  });
  return { ProjectionExpression: parts.join(", "), ExpressionAttributeNames: names };
}

function filterExpr(f: DynamoFilter | undefined, start: number): { FilterExpression?: string; names: Record<string, string>; values: Record<string, unknown> } {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const parts: string[] = [];
  let i = start;
  for (const [k, v] of Object.entries(f?.eq ?? {})) {
    names[`#c${i}`] = k;
    values[`:c${i}`] = v;
    parts.push(`#c${i} = :c${i}`);
    i++;
  }
  if (f?.gte) {
    names[`#c${i}`] = f.gte.field;
    values[`:c${i}`] = f.gte.value;
    parts.push(`#c${i} >= :c${i}`);
  }
  return { ...(parts.length ? { FilterExpression: parts.join(" AND ") } : {}), names, values };
}

export function dynamoInputFields(input: { fields?: string[]; key?: Record<string, unknown>; filter?: DynamoFilter }): string[] {
  return [
    ...(input.fields ?? []),
    ...Object.keys(input.key ?? {}),
    ...Object.keys(input.filter?.eq ?? {}),
    ...(input.filter?.gte ? [input.filter.gte.field] : []),
  ];
}

export function rawDynamoFacade(doc: DocSend): DynamoFacade {
  const bounded = async (cmd: unknown) =>
    Promise.race([
      doc.send(cmd),
      new Promise<never>((_, rej) => setTimeout(() => rej(new ExpectedToolError("operator_db_timeout", "DynamoDB request exceeded time budget.")), REQUEST_TIMEOUT_MS)),
    ]);
  return {
    async scan(input: DynamoScanInput) {
      const proj = projection(input.fields);
      const flt = filterExpr(input.filter, 0);
      const names = { ...(proj.ExpressionAttributeNames ?? {}), ...flt.names };
      const r = await bounded(
        new ScanCommand({
          TableName: input.table,
          Limit: Math.min(input.limit, MAX_DYNAMO_ITEMS),
          ...(proj.ProjectionExpression ? { ProjectionExpression: proj.ProjectionExpression } : {}),
          ...(flt.FilterExpression ? { FilterExpression: flt.FilterExpression, ExpressionAttributeValues: flt.values } : {}),
          ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        }),
      );
      return (r.Items ?? []).slice(0, MAX_DYNAMO_ITEMS);
    },
    async query(input: DynamoQueryInput) {
      const keyNames: Record<string, string> = {};
      const keyValues: Record<string, unknown> = {};
      const conds = Object.entries(input.key).map(([k, v], i) => {
        keyNames[`#k${i}`] = k;
        keyValues[`:v${i}`] = v;
        return `#k${i} = :v${i}`;
      });
      const proj = projection(input.fields);
      const flt = filterExpr(input.filter, conds.length);
      const r = await bounded(
        new QueryCommand({
          TableName: input.table,
          ...(input.index ? { IndexName: input.index } : {}),
          KeyConditionExpression: conds.join(" AND "),
          ExpressionAttributeNames: { ...keyNames, ...(proj.ExpressionAttributeNames ?? {}), ...flt.names },
          ExpressionAttributeValues: { ...keyValues, ...flt.values },
          ...(proj.ProjectionExpression ? { ProjectionExpression: proj.ProjectionExpression } : {}),
          ...(flt.FilterExpression ? { FilterExpression: flt.FilterExpression } : {}),
          ...(input.scanIndexForward === false ? { ScanIndexForward: false } : {}),
          Limit: Math.min(input.limit, MAX_DYNAMO_ITEMS),
        }),
      );
      return (r.Items ?? []).slice(0, MAX_DYNAMO_ITEMS);
    },
  };
}

export function stripDynamoItem(table: string, item: Record<string, unknown>, policy: Policy): Record<string, unknown> {
  const unhidden = new Set(policy.unhiddenFields(table));
  const hidden = policy.hiddenFields(table).map((h) => normalizePath(h).join("."));
  const drop = (path: string, key: string) => {
    if (policy.isHidden(table, path) || policy.isHidden(table, key)) return true;
    const np = normalizePath(path).join(".");
    if (hidden.some((h) => h === np || np.startsWith(h + "."))) return true;
    return isSensitiveField(table, key) && !unhidden.has(path);
  };
  const walk = (v: unknown, path: string, depth: number): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (depth >= 12) return null;
    if (Array.isArray(v)) return v.map((x) => walk(x, path, depth + 1));
    if (v instanceof Set || v instanceof Uint8Array) return v;
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (drop(p, k)) continue;
      o[k] = walk(x, p, depth + 1);
    }
    return o;
  };
  return walk(item, "", 0) as Record<string, unknown>;
}

export function dynamoInputRefusal(
  input: { table: string; fields?: string[]; key?: Record<string, unknown>; filter?: DynamoFilter },
  policy: Policy,
): string | null {
  const t = policy.resolve(input.table, true);
  if (!t) return `${input.table} is not a table Zavi may read.`;
  const unhidden = new Set(policy.unhiddenFields(t.name));
  for (const f of dynamoInputFields(input)) {
    if (!FIELD_RE.test(f) || f.includes(".")) return `${f} is not a plain attribute name.`;
    if (policy.isHidden(t.name, f) || (isSensitiveField(t.name, f) && !unhidden.has(f))) return `${t.name}.${f} is hidden in What Zavi can see.`;
  }
  return null;
}

export function guardedDynamoFacade(inner: DynamoFacade, policy: Policy): DynamoFacade {
  const check = (input: { table: string; fields?: string[]; key?: Record<string, unknown>; filter?: DynamoFilter }): string => {
    const why = dynamoInputRefusal(input, policy);
    if (why) throw new GatewayRefusal(why, "zavi", [input.table]);
    return policy.resolve(input.table, true)!.name;
  };
  return {
    async scan(input) {
      const table = check(input);
      const items = await inner.scan({ ...input, table, limit: Math.max(1, Math.min(input.limit, MAX_DYNAMO_ITEMS)) });
      return items.map((it) => stripDynamoItem(table, it, policy));
    },
    async query(input) {
      const table = check(input);
      const items = await inner.query({ ...input, table, limit: Math.max(1, Math.min(input.limit, MAX_DYNAMO_ITEMS)) });
      return items.map((it) => stripDynamoItem(table, it, policy));
    },
  };
}

export async function openDynamoSession(connectionString: string): Promise<ReadSession> {
  const low = makeDynamoClient(parseDynamodbUri(connectionString));
  const doc = DynamoDBDocumentClient.from(low, { marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true } });
  const facade = rawDynamoFacade(doc as unknown as DocSend);
  const unsupported = (op: string) => new ExpectedToolError("operator_db_unsupported_dialect", `${op} is not available on a DynamoDB database.`);
  let closed = false;
  return {
    dialect: "dynamodb",
    query: async () => {
      throw unsupported("SQL reads");
    },
    mongo: () => {
      throw unsupported("Mongo reads");
    },
    dynamo: () => facade,
    sessionTimeZone: () => undefined,
    largestTableRows: async () => null,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        low.destroy();
      } catch {
      }
    },
  };
}
