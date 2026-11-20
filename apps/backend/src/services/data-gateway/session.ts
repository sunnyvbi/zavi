import type { Document } from "mongodb";

export type SqlDialect = "postgres" | "mysql";
export type SessionDialect = "postgres" | "mysql" | "mongodb" | "dynamodb";

export type SqlField = { name: string; dataTypeID?: number };
export type SqlResult = {
  rows: Record<string, unknown>[];
  fields: SqlField[];
  truncated: boolean;
};
export type SqlQueryOptions = {
  maxRows?: number;
  label?: string;
};

export type MongoFindOptions = {
  projection?: Record<string, unknown>;
  sort?: Record<string, unknown>;
  limit?: number;
  skip?: number;
  maxTimeMS?: number;
  hint?: unknown;
};

export interface MongoFacade {
  readonly database: { name: string; explicit: boolean };
  find(collection: string, filter: Record<string, unknown>, options?: MongoFindOptions): Promise<Document[]>;
  findOne(collection: string, filter: Record<string, unknown>, options?: MongoFindOptions): Promise<Document | null>;
  aggregate(collection: string, pipeline: Record<string, unknown>[], options?: { maxTimeMS?: number; allowDiskUse?: boolean; failIfTruncated?: boolean }): Promise<Document[]>;
  countDocuments(collection: string, filter: Record<string, unknown>, options?: { maxTimeMS?: number; limit?: number }): Promise<number>;
  estimatedDocumentCount(collection: string, options?: { maxTimeMS?: number }): Promise<number>;
  listCollections(): Promise<{ name: string; type?: string; options?: Record<string, unknown> }[]>;
}

export type DynamoFilter = { eq?: Record<string, string | number>; gte?: { field: string; value: string | number } };
export type DynamoScanInput = { table: string; fields?: string[]; filter?: DynamoFilter; limit: number };
export type DynamoQueryInput = {
  table: string;
  key: Record<string, string | number>;
  index?: string;
  fields?: string[];
  filter?: DynamoFilter;
  scanIndexForward?: boolean;
  limit: number;
};
export interface DynamoFacade {
  scan(input: DynamoScanInput): Promise<Record<string, unknown>[]>;
  query(input: DynamoQueryInput): Promise<Record<string, unknown>[]>;
}

export interface ReadSession {
  readonly dialect: SessionDialect;
  query(text: string, params?: unknown[], opts?: SqlQueryOptions): Promise<SqlResult>;
  mongo(): MongoFacade;
  dynamo(): DynamoFacade;
  sessionTimeZone(): string | undefined;
  largestTableRows(names: string[]): Promise<number | null>;
  close(): Promise<void>;
}

