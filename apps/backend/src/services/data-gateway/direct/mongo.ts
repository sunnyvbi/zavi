import { BSON, MongoClient, type CommandStartedEvent, type Document } from "mongodb";
import { ExpectedToolError } from "@/services/tools/types";
import type { MongoFacade, MongoFindOptions, ReadSession } from "../session";

const CONNECT_TIMEOUT_MS = 8_000;
export const MONGO_READ_MAX_TIME_MS = 5_000;

const READ_ONLY_COMMANDS = new Set([
  "aggregate", "count", "distinct", "find", "listCollections", "getMore", "killCursors",
  "endSessions", "ping", "hello", "isMaster", "ismaster", "buildInfo", "saslStart", "saslContinue",
]);
const WRITE_STAGES = ["$out", "$merge"];

export type MongoDbName = { name: string; explicit: boolean };

export function mongoDbNameFromUri(uri: string): MongoDbName {
  try {
    const u = new URL(uri);
    const pathDb = u.pathname.replace(/^\//, "").split("/")[0] ?? "";
    if (pathDb) return { name: decodeURIComponent(pathDb), explicit: true };
  } catch {
    throw new ExpectedToolError(
      "operator_db_bad_connection_uri",
      "Operator DB connection string is not a valid URI — cannot resolve the database name.",
    );
  }
  return { name: "test", explicit: false };
}

function pipelineWrites(pipeline: unknown[]): boolean {
  for (const st of pipeline) {
    if (!st || typeof st !== "object") continue;
    if (WRITE_STAGES.some((w) => w in (st as object))) return true;
    const lk = (st as { $lookup?: { pipeline?: unknown } }).$lookup;
    if (lk && Array.isArray(lk.pipeline) && pipelineWrites(lk.pipeline)) return true;
    const fc = (st as { $facet?: Record<string, unknown> }).$facet;
    if (fc && Object.values(fc).some((p) => Array.isArray(p) && pipelineWrites(p))) return true;
  }
  return false;
}

export async function openMongoSession(connectionString: string): Promise<ReadSession> {
  const db = mongoDbNameFromUri(connectionString);
  const client = new MongoClient(connectionString, {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
    readPreference: "secondaryPreferred",
    retryWrites: false,
    monitorCommands: true,
  });
  let violation: string | null = null;
  client.on("commandStarted", (event: CommandStartedEvent) => {
    if (!READ_ONLY_COMMANDS.has(event.commandName)) violation = event.commandName;
    const pipe = (event.command as { pipeline?: unknown }).pipeline;
    if (Array.isArray(pipe) && pipelineWrites(pipe)) violation = "aggregate with a write stage";
  });
  await client.connect();
  const handle = client.db(db.name);
  let closed = false;
  const check = () => {
    if (closed) throw new ExpectedToolError("operator_db_session_closed", "The database session is closed.");
    if (violation) throw new ExpectedToolError("operator_db_not_read_only", `A non-read Mongo command was attempted (${violation}).`);
  };

  const facade: MongoFacade = {
    database: db,
    async find(collection, filter, options: MongoFindOptions = {}) {
      check();
      let cur = handle.collection(collection).find(filter, { maxTimeMS: options.maxTimeMS ?? MONGO_READ_MAX_TIME_MS, ...(options.hint ? { hint: options.hint as Document } : {}) });
      if (options.projection) cur = cur.project(options.projection as Document);
      if (options.sort) cur = cur.sort(options.sort as Document);
      if (options.skip) cur = cur.skip(options.skip);
      if (options.limit !== undefined) cur = cur.limit(options.limit);
      const out = await cur.toArray();
      check();
      return out;
    },
    async findOne(collection, filter, options: MongoFindOptions = {}) {
      check();
      const doc = await handle.collection(collection).findOne(filter, {
        maxTimeMS: options.maxTimeMS ?? MONGO_READ_MAX_TIME_MS,
        ...(options.projection ? { projection: options.projection as Document } : {}),
        ...(options.sort ? { sort: options.sort as Document } : {}),
      });
      check();
      return doc;
    },
    async aggregate(collection, pipeline, options = {}) {
      check();
      if (pipelineWrites(pipeline)) throw new ExpectedToolError("operator_db_not_read_only", "Aggregate pipelines must not write.");
      const out = await handle
        .collection(collection)
        .aggregate(pipeline as Document[], { maxTimeMS: options.maxTimeMS ?? MONGO_READ_MAX_TIME_MS, ...(options.allowDiskUse ? { allowDiskUse: true } : {}) })
        .toArray();
      check();
      return out;
    },
    async countDocuments(collection, filter, options = {}) {
      check();
      const n = await handle.collection(collection).countDocuments(filter, {
        maxTimeMS: options.maxTimeMS ?? MONGO_READ_MAX_TIME_MS,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
      check();
      return n;
    },
    async estimatedDocumentCount(collection, options = {}) {
      check();
      const n = await handle.collection(collection).estimatedDocumentCount({ maxTimeMS: options.maxTimeMS ?? MONGO_READ_MAX_TIME_MS });
      check();
      return n;
    },
    async listCollections() {
      check();
      const out = await handle.listCollections({}, { nameOnly: false }).toArray();
      check();
      return out.map((c) => ({ name: c.name, type: (c as { type?: string }).type, options: (c as { options?: Record<string, unknown> }).options }));
    },
  };

  const unsupported = (op: string) => new ExpectedToolError("operator_db_unsupported_dialect", `${op} is not available on a MongoDB database.`);
  return {
    dialect: "mongodb",
    query: async () => {
      throw unsupported("SQL reads");
    },
    mongo: () => facade,
    dynamo: () => {
      throw unsupported("DynamoDB reads");
    },
    sessionTimeZone: () => undefined,
    largestTableRows: async () => null,
    close: async () => {
      if (closed) return;
      closed = true;
      await client.close().catch(() => undefined);
    },
  };
}

export function toWireEjson<T>(v: T): T {
  return v === undefined ? v : (BSON.EJSON.serialize(v as Document, { relaxed: true }) as T);
}
export function fromWireEjson(v: unknown): Document {
  return BSON.EJSON.deserialize(v as Document, { relaxed: true }) as Document;
}
