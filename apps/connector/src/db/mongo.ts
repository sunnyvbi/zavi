import type { CommandStartedEvent, Document, MongoClient, MongoClientOptions } from "mongodb";
import { mongoStructureColumns, mongoStructurePipeline, readMongoStructure, MONGO_STRUCTURE_MAX_NESTED } from "@zavi/shared/db-guard";
import { CONNECT_TIMEOUT_MS, DriverUnsupported, SAFE_NAME, TABLE_CAP, type Driver, type IntroTable, type Introspection, type MongoRunner } from "./types";

export type MongoFactory = (uri: string, opts: MongoClientOptions) => Promise<MongoClient>;

const defaultFactory: MongoFactory = async (uri, opts) => {
  const { MongoClient: Ctor } = await import("mongodb");
  return new Ctor(uri, opts);
};

const READ_COMMANDS = new Set([
  "aggregate", "count", "find", "listCollections", "getMore", "killCursors", "endSessions", "ping", "hello", "isMaster", "ismaster",
  "buildInfo", "saslStart", "saslContinue", "collStats",
]);
const WRITE_STAGES = ["$out", "$merge"];

export function pipelineWrites(pipeline: unknown[], depth = 0): boolean {
  if (depth > 30) return true;
  for (const st of pipeline) {
    if (!st || typeof st !== "object") continue;
    if (WRITE_STAGES.some((w) => w in (st as object))) return true;
    const lk = (st as { $lookup?: { pipeline?: unknown } }).$lookup;
    if (lk && Array.isArray(lk.pipeline) && pipelineWrites(lk.pipeline, depth + 1)) return true;
    const fc = (st as { $facet?: Record<string, unknown> }).$facet;
    if (fc && Object.values(fc).some((p) => Array.isArray(p) && pipelineWrites(p, depth + 1))) return true;
  }
  return false;
}

export function mongoDatabaseOf(uri: string): string | null {
  try {
    const db = decodeURIComponent(new URL(uri).pathname.replace(/^\//, "").split("/")[0] ?? "");
    return db || null;
  } catch {
    return null;
  }
}

export class MongoNotReadOnly extends Error {
  constructor(what: string) {
    super(`A non-read MongoDB command was attempted (${what}); the connection was closed.`);
    this.name = "MongoNotReadOnly";
  }
}

export function mongoTls(uri: string): { opts: MongoClientOptions; transport: "verified_tls" | "unverified_tls" | "plaintext" } {
  const explicit = /[?&](tls|ssl)=(true|false)/i.exec(uri);
  const insecure = /[?&](tlsInsecure|tlsAllowInvalidCertificates)=true/i.test(uri);
  if (/^mongodb\+srv:/i.test(uri) || explicit?.[2]?.toLowerCase() === "true") return { opts: {}, transport: insecure ? "unverified_tls" : "verified_tls" };
  if (explicit?.[2]?.toLowerCase() === "false") return { opts: {}, transport: "plaintext" };
  const hosts = (/^mongodb:\/\/(?:[^@/]*@)?([^/?]*)/i.exec(uri)?.[1] ?? "").split(",").map((h) => h.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase());
  const loopback = hosts.every((h) => h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h));
  if (loopback) return { opts: {}, transport: "plaintext" };
  return { opts: { tls: true, tlsAllowInvalidCertificates: true }, transport: "unverified_tls" };
}

export function openMongo(uri: string, factory: MongoFactory = defaultFactory): Driver {
  const database = mongoDatabaseOf(uri);
  const tls = mongoTls(uri);
  let clientP: Promise<MongoClient> | null = null;
  let violation: string | null = null;

  async function client(): Promise<MongoClient> {
    if (!database) throw new Error("The MongoDB connection string has no database name. Add /<database> after the host.");
    if (violation) throw new MongoNotReadOnly(violation);
    if (!clientP) {
      clientP = (async () => {
        const c = await factory(uri, {
          serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
          connectTimeoutMS: CONNECT_TIMEOUT_MS,
          socketTimeoutMS: 60_000,
          readPreference: "secondaryPreferred",
          retryWrites: false,
          monitorCommands: true,
          appName: "zavi-connector",
          maxPoolSize: 8,
          ...tls.opts,
        });
        c.on("commandStarted", (ev: CommandStartedEvent) => {
          if (!READ_COMMANDS.has(ev.commandName)) violation = ev.commandName;
          const pipe = (ev.command as { pipeline?: unknown }).pipeline;
          if (Array.isArray(pipe) && pipelineWrites(pipe)) violation = "aggregate with a write stage";
          if (violation) void c.close(true).catch(() => undefined);
        });
        await c.connect();
        return c;
      })();
      clientP.catch(() => {
        clientP = null;
      });
    }
    return clientP;
  }

  const db = async () => (await client()).db(database!);
  const check = () => {
    if (violation) throw new MongoNotReadOnly(violation);
  };

  async function collect(cursor: AsyncIterable<Document> & { close(): Promise<void> }, maxRows: number) {
    const docs: Document[] = [];
    let truncated = false;
    try {
      for await (const d of cursor) {
        if (docs.length >= maxRows) {
          truncated = true;
          break;
        }
        docs.push(d);
      }
    } finally {
      await cursor.close().catch(() => undefined);
    }
    check();
    return { docs, truncated };
  }

  const runner: MongoRunner = {
    async find(collection, filter, options, maxRows, maxTimeMS) {
      const h = await db();
      let cur = h.collection(collection).find(filter, { maxTimeMS });
      if (options.projection) cur = cur.project(options.projection as Document);
      if (options.sort) cur = cur.sort(options.sort as Document);
      if (typeof options.skip === "number") cur = cur.skip(options.skip);
      if (options.hint) cur = cur.hint(options.hint as Document);
      const own = typeof options.limit === "number" && options.limit > 0 && options.limit <= maxRows;
      cur = cur.limit(own ? (options.limit as number) : maxRows + 1);
      return collect(cur, own ? (options.limit as number) : maxRows);
    },
    async aggregate(collection, pipeline, maxRows, maxTimeMS, allowDiskUse) {
      if (pipelineWrites(pipeline)) throw new MongoNotReadOnly("aggregate with a write stage");
      const h = await db();
      return collect(h.collection(collection).aggregate([...pipeline, { $limit: maxRows + 1 }], { maxTimeMS, ...(allowDiskUse ? { allowDiskUse: true } : {}) }), maxRows);
    },
    async countDocuments(collection, filter, limit, maxTimeMS) {
      const n = await (await db()).collection(collection).countDocuments(filter, { maxTimeMS, ...(limit !== undefined ? { limit } : {}) });
      check();
      return n;
    },
    async estimatedDocumentCount(collection, maxTimeMS) {
      const n = await (await db()).collection(collection).estimatedDocumentCount({ maxTimeMS });
      check();
      return n;
    },
    async listCollections(maxTimeMS) {
      const out = await (await db()).listCollections({}, { nameOnly: false, maxTimeMS }).toArray();
      check();
      return out.map((c) => ({ name: c.name, ...(typeof (c as { type?: unknown }).type === "string" ? { type: (c as { type: string }).type } : {}) }));
    },
  };

  async function introspect(deadlineAt: number): Promise<Introspection> {
    const h = await db();
    const colls = (await h.listCollections({}, { nameOnly: false, maxTimeMS: 5_000 }).toArray()) as Array<{ name: string; type?: string; options?: { viewOn?: unknown } }>;
    check();
    const safe = colls.filter((c) => SAFE_NAME.test(c.name) && !c.name.startsWith("system."));
    const picked = safe.slice(0, TABLE_CAP);
    const tables: IntroTable[] = [];
    let deadlineHit = false;
    for (const c of picked) {
      if (Date.now() > deadlineAt) {
        deadlineHit = true;
        break;
      }
      const isView = c.type === "view";
      const topRows = await readMongoStructure(h.collection(c.name), mongoStructurePipeline());
      check();
      if (topRows === null) {
        deadlineHit = true;
        continue;
      }
      const top = mongoStructureColumns(topRows);
      const columns = top.map(({ name, type, nullable }) => ({ name, type, nullable }));
      for (const parent of top.filter((x) => x.rawTypes.includes("object") && SAFE_NAME.test(x.name)).slice(0, MONGO_STRUCTURE_MAX_NESTED)) {
        if (Date.now() > deadlineAt) {
          deadlineHit = true;
          break;
        }
        const rows = await readMongoStructure(h.collection(c.name), mongoStructurePipeline({ nestedKey: parent.name }));
        if (rows === null) {
          deadlineHit = true;
          continue;
        }
        for (const n of mongoStructureColumns(rows, parent.name)) columns.push({ name: n.name, type: n.type, nullable: n.nullable });
      }
      const est = isView ? null : await h.collection(c.name).estimatedDocumentCount({ maxTimeMS: 5_000 }).catch(() => null);
      check();
      tables.push({ name: c.name, columns, rowEstimate: est, ...(isView && typeof c.options?.viewOn === "string" ? { view_of: c.options.viewOn } : isView ? { view_of: "?" } : {}) });
    }
    return { dialect: "mongodb", database, tables, skippedUnsafeNames: colls.length - safe.length, namesSeenTotal: colls.length, deadlineHit, listingTruncated: safe.length > picked.length };
  }

  return {
    dialect: "mongodb",
    database,
    test: async () => {
      await (await db()).command({ ping: 1 });
      check();
    },
    introspect,
    sql: async () => {
      throw new DriverUnsupported("SQL reads", "MongoDB");
    },
    mongo: () => runner,
    transport: () => tls.transport,
    close: async () => {
      const p = clientP;
      clientP = null;
      if (p) await (await p.catch(() => null))?.close().catch(() => undefined);
    },
  };
}
