import type { Document } from "bson";

export type Dialect = "postgres" | "mysql" | "mongodb";

export type IntroColumn = { name: string; type: string; nullable: boolean;  json_keys?: string[]; json_sampled?: "full" | "partial" | "none"; json_map_like?: boolean };
export type IntroTable = {
  name: string;
  columns: IntroColumn[];
  rowEstimate: number | null;
  partitioned?: boolean;
  partitions?: string[];
  parents?: string[];
  view_of?: string;
};
export type Introspection = {
  dialect: Dialect;
  database: string | null;
  tables: IntroTable[];
  skippedUnsafeNames: number;
  namesSeenTotal: number;
  deadlineHit: boolean;
  listingTruncated: boolean;
};

export type SqlRunOptions = {
  maxRows: number;
  timeoutMs: number;
  timeZone?: string;
  utcOffset?: boolean;
};
export type SqlRunResult = { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean };

export type MongoRunner = {
  find(collection: string, filter: Document, options: Document, maxRows: number, maxTimeMS: number): Promise<{ docs: Document[]; truncated: boolean }>;
  aggregate(collection: string, pipeline: Document[], maxRows: number, maxTimeMS: number, allowDiskUse?: boolean): Promise<{ docs: Document[]; truncated: boolean }>;
  countDocuments(collection: string, filter: Document, limit: number | undefined, maxTimeMS: number): Promise<number>;
  estimatedDocumentCount(collection: string, maxTimeMS: number): Promise<number>;
  listCollections(maxTimeMS: number): Promise<{ name: string; type?: string }[]>;
};

export type Driver = {
  dialect: Dialect;
  database: string | null;
  test(): Promise<void>;
  introspect(deadlineAt: number): Promise<Introspection>;
  sql(text: string, params: unknown[], opts: SqlRunOptions): Promise<SqlRunResult>;
  mongo(): MongoRunner;
  transport(): "verified_tls" | "unverified_tls" | "plaintext" | null;
  close(): Promise<void>;
};

export const SAFE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export const TABLE_CAP = 1000;
export const COLUMN_BATCH = 200;
export const CONNECT_TIMEOUT_MS = 8_000;

export class DriverUnsupported extends Error {
  constructor(what: string, dialect: string) {
    super(`${what} is not available on a ${dialect} database.`);
    this.name = "DriverUnsupported";
  }
}
