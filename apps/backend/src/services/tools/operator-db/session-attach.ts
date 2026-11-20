import type { Document } from "mongodb";
import type { DynamoFacade, MongoFacade, MongoFindOptions, ReadSession } from "@/services/data-gateway/session";
import { ExpectedToolError } from "@/services/tools/types";
import type { SchemaMap } from "./types";

const SESSIONS = new WeakMap<object, ReadSession>();

export function attachSession<T extends object>(cfg: T, session: ReadSession): T {
  SESSIONS.set(cfg, session);
  return cfg;
}

export function sessionFor(cfg: SchemaMap | object): ReadSession {
  const s = SESSIONS.get(cfg);
  if (!s) throw new ExpectedToolError("operator_db_no_conn", "database session not attached to schema_map at call time");
  return s;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PgLike = { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, any>[] }> };
export async function withSql<T>(cfg: SchemaMap, fn: (c: PgLike) => Promise<T>): Promise<T> {
  const s = sessionFor(cfg);
  return fn({ query: async (sql, params) => ({ rows: (await s.query(sql, params ?? [])).rows }) });
}

export type MysqlLike = { query(sql: string, params?: unknown[]): Promise<[Record<string, unknown>[], { name: string }[]]> };
export async function withMysql<T>(cfg: SchemaMap, fn: (c: MysqlLike) => Promise<T>): Promise<T> {
  const s = sessionFor(cfg);
  return fn({
    query: async (sql, params) => {
      const r = await s.query(sql, params ?? []);
      return [r.rows, r.fields];
    },
  });
}

export type MongoCursorLike = {
  project(p: Document): MongoCursorLike;
  sort(s: Document): MongoCursorLike;
  skip(n: number): MongoCursorLike;
  limit(n: number): MongoCursorLike;
  toArray(): Promise<Document[]>;
};
export type MongoCollectionLike = {
  findOne(filter: Document, opts?: { projection?: Document; maxTimeMS?: number; sort?: Document }): Promise<Document | null>;
  find(filter: Document, opts?: { maxTimeMS?: number; projection?: Document }): MongoCursorLike;
  aggregate(pipeline: Document[], opts?: { maxTimeMS?: number; allowDiskUse?: boolean; failIfTruncated?: boolean }): { toArray(): Promise<Document[]> };
  countDocuments(filter: Document, opts?: { limit?: number; maxTimeMS?: number }): Promise<number>;
  estimatedDocumentCount(opts?: { maxTimeMS?: number }): Promise<number>;
};
export type MongoDbLike = { collection(name: string): MongoCollectionLike };

export function mongoDbAdapter(facade: MongoFacade): MongoDbLike {
  return {
    collection(name: string): MongoCollectionLike {
      return {
        findOne: (filter, opts = {}) => facade.findOne(name, filter, { projection: opts.projection, sort: opts.sort, maxTimeMS: opts.maxTimeMS }),
        find(filter, opts = {}) {
          const o: MongoFindOptions = { maxTimeMS: opts.maxTimeMS, ...(opts.projection ? { projection: opts.projection } : {}) };
          const cur: MongoCursorLike = {
            project(p) {
              o.projection = p;
              return cur;
            },
            sort(sp) {
              o.sort = sp;
              return cur;
            },
            skip(n) {
              o.skip = n;
              return cur;
            },
            limit(n) {
              o.limit = n;
              return cur;
            },
            toArray: () => facade.find(name, filter, o),
          };
          return cur;
        },
        aggregate: (pipeline, opts = {}) => ({ toArray: () => facade.aggregate(name, pipeline as Record<string, unknown>[], opts) }),
        countDocuments: (filter, opts = {}) => facade.countDocuments(name, filter, opts),
        estimatedDocumentCount: (opts = {}) => facade.estimatedDocumentCount(name, opts),
      };
    },
  };
}

export async function withMongoDb<T>(cfg: SchemaMap, fn: (db: MongoDbLike) => Promise<T>, opts: { strict?: boolean } = {}): Promise<T> {
  const facade = sessionFor(cfg).mongo();
  if (opts.strict && !facade.database.explicit) {
    throw new ExpectedToolError(
      "operator_db_no_database_in_uri",
      "Operator DB connection string has no database name in its path. The generic read requires an explicit database (no 'test' fallback).",
    );
  }
  return fn(mongoDbAdapter(facade));
}

export function withMongoDbStrict<T>(cfg: SchemaMap, fn: (db: MongoDbLike) => Promise<T>): Promise<T> {
  return withMongoDb(cfg, fn, { strict: true });
}

export function dynamoFor(cfg: SchemaMap): DynamoFacade {
  return sessionFor(cfg).dynamo();
}
