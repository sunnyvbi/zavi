
import { MongoClient } from "mongodb";
import { mongoStructurePipeline, mongoStructureColumns, readMongoStructure, MONGO_STRUCTURE_MAX_NESTED } from "@zavi/shared/db-guard";
import type { RawIntrospection, RawTable, RawColumn } from "@/services/tools/operator-db/types";
import { prioritizeAndCap, isSafeName, DEFAULT_TABLE_CAP } from "@/services/tools/operator-db/discovery/util";

export const MONGO_STRUCTURE_SCAN_TEXT =
  "Structure scan: read collection and field names and types (sampled documents are used in memory to infer field types and are not stored)";

export function viewRemovedFields(pipeline: unknown): string[] {
  if (!Array.isArray(pipeline) || pipeline.length === 0) return [];
  const first = pipeline[0] as Record<string, unknown> | null;
  if (!first || typeof first !== "object") return [];
  if (first.$unset !== undefined) {
    const u = first.$unset;
    return (Array.isArray(u) ? u : [u]).filter((x): x is string => typeof x === "string");
  }
  const proj = first.$project as Record<string, unknown> | undefined;
  if (!proj || typeof proj !== "object") return [];
  return Object.entries(proj).filter(([, v]) => v === 0 || v === false).map(([k]) => k);
}

export const MONGO_STRUCTURE_MAX_TIME_MS = 5000;
export const MONGO_COLLECTION_BUDGET_MS = 15_000;

export function structureTimeLeft(deadlineMs: number, now: number = Date.now()): number | null {
  const left = Math.min(MONGO_STRUCTURE_MAX_TIME_MS, deadlineMs - now);
  return left >= 250 ? Math.floor(left) : null;
}

export async function introspectMongo(
  connectionString: string,
  tableCap: number = DEFAULT_TABLE_CAP,
  deadlineMs: number = Date.now() + 25_000,
): Promise<RawIntrospection> {
  const client = new MongoClient(connectionString, {
    serverSelectionTimeoutMS: 8000,
    socketTimeoutMS: 10000,
    readPreference: "secondaryPreferred",
    retryWrites: false,
  });
  try {
    await client.connect();
    const pathDb = (() => {
      try {
        const u = new URL(connectionString);
        return decodeURIComponent(u.pathname.replace(/^\//, "").split("/")[0] ?? "");
      } catch { return ""; }
    })();
    if (!pathDb) throw new Error("Operator DB connection string has no database name in its path — add /dbname to the URI.");
    const db = client.db(pathDb);
    const colls = await db
      .listCollections({}, { nameOnly: false, maxTimeMS: 5000 })
      .toArray();
    const allNames = colls.map((c) => c.name);
    const viewInfo = new Map<string, { view_of: string; removed_fields: string[] }>();
    for (const c of colls as Array<{ name: string; type?: string; options?: { viewOn?: unknown; pipeline?: unknown } }>) {
      if (c.type !== "view" || typeof c.options?.viewOn !== "string") continue;
      viewInfo.set(c.name, { view_of: c.options.viewOn, removed_fields: viewRemovedFields(c.options.pipeline) });
    }
    const skippedUnsafeNames = allNames.filter((n) => !isSafeName(n)).length;
    const picked = prioritizeAndCap(allNames, tableCap);

    let deadlineHit = false;
    const tables: RawTable[] = [];
    for (const name of picked) {
      const topMs = structureTimeLeft(deadlineMs);
      if (topMs === null) {
        deadlineHit = true;
        break;
      }
      const collStart = Date.now();
      const topRows = await readMongoStructure(db.collection(name), mongoStructurePipeline(), topMs);
      if (topRows === null) {
        deadlineHit = true;
        continue;
      }
      const top = mongoStructureColumns(topRows);
      const columns: RawColumn[] = top.map(({ name: n, type, nullable }) => ({ name: n, type, nullable }));
      const nested = top.filter((c) => c.rawTypes.includes("object") && isSafeName(c.name)).slice(0, MONGO_STRUCTURE_MAX_NESTED);
      for (const parent of nested) {
        const nestedMs = structureTimeLeft(Math.min(deadlineMs, collStart + MONGO_COLLECTION_BUDGET_MS));
        if (nestedMs === null) {
          deadlineHit = true;
          break;
        }
        const rows = await readMongoStructure(db.collection(name), mongoStructurePipeline({ nestedKey: parent.name }), nestedMs);
        if (rows === null) {
          deadlineHit = true;
          continue;
        }
        for (const c of mongoStructureColumns(rows, parent.name)) columns.push({ name: c.name, type: c.type, nullable: c.nullable });
      }
      const view = viewInfo.get(name);
      tables.push({ name, columns, rowEstimate: null, ...(view ?? {}) });
    }
    return {
      dialect: "mongodb", tables, skippedUnsafeNames,
      namesSeenTotal: allNames.length,
      deadlineHit,
      listingTruncated: false };
  } finally {
    await client.close().catch(() => undefined);
  }
}
