
import { Client } from "pg";
import { createConnection } from "mysql2/promise";
import { MongoClient } from "mongodb";
import type { ColType, Dataset, Table } from "./types";

const PG_TYPE: Record<ColType, string> = {
  pk: "bigint primary key",
  int: "integer",
  bigint: "bigint",
  text: "text",
  bool: "boolean",
  timestamp: "timestamptz",
  date: "date",
  numeric: "numeric(18,6)",
  json: "jsonb",
};

const MYSQL_TYPE: Record<ColType, string> = {
  pk: "bigint primary key",
  int: "int",
  bigint: "bigint",
  text: "varchar(255)",
  bool: "tinyint(1)",
  timestamp: "datetime(3)",
  date: "date",
  numeric: "decimal(18,6)",
  json: "json",
};

function ddl(t: Table, types: Record<ColType, string>, quote: (s: string) => string): string {
  const cols = t.columns
    .map((c) => `${quote(c.name)} ${types[c.type]}${c.nullable ? "" : c.type === "pk" ? "" : ""}`)
    .join(", ");
  return `CREATE TABLE ${quote(t.name)} (${cols})`;
}

const pgQuote = (s: string) => `"${s}"`;
const myQuote = (s: string) => `\`${s}\``;

export async function loadPostgres(ds: Dataset, connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const t of ds.tables) {
      await client.query(`DROP TABLE IF EXISTS ${pgQuote(t.name)}`);
      await client.query(ddl(t, PG_TYPE, pgQuote));
      if (t.rows.length === 0) continue;
      const colNames = t.columns.map((c) => c.name);
      const CHUNK = 500;
      for (let i = 0; i < t.rows.length; i += CHUNK) {
        const chunk = t.rows.slice(i, i + CHUNK);
        const values: unknown[] = [];
        const tuples = chunk.map((row) => {
          const ph = t.columns.map((col) => {
            values.push(normalize(row[col.name], col.type));
            return `$${values.length}`;
          });
          return `(${ph.join(",")})`;
        });
        await client.query(
          `INSERT INTO ${pgQuote(t.name)} (${colNames.map(pgQuote).join(",")}) VALUES ${tuples.join(",")}`,
          values,
        );
      }
    }
  } finally {
    await client.end();
  }
}

export async function loadMysql(ds: Dataset, connectionString: string): Promise<void> {
  const conn = await createConnection(connectionString);
  try {
    await conn.query("SET time_zone = '+00:00'");
    await conn.query("SET FOREIGN_KEY_CHECKS=0");
    for (const t of ds.tables) {
      await conn.query(`DROP TABLE IF EXISTS ${myQuote(t.name)}`);
      await conn.query(ddl(t, MYSQL_TYPE, myQuote));
      if (t.rows.length === 0) continue;
      const colNames = t.columns.map((c) => c.name);
      const CHUNK = 500;
      for (let i = 0; i < t.rows.length; i += CHUNK) {
        const chunk = t.rows.slice(i, i + CHUNK);
        const tuples = chunk.map((row) => t.columns.map((col) => normalizeMysql(row[col.name], col.type)));
        await conn.query(
          `INSERT INTO ${myQuote(t.name)} (${colNames.map(myQuote).join(",")}) VALUES ?`,
          [tuples],
        );
      }
    }
  } finally {
    await conn.end();
  }
}

export async function loadMongo(ds: Dataset, uri: string, dbName: string): Promise<void> {
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(dbName);
    for (const t of ds.tables) {
      await db.collection(t.name).drop().catch(() => undefined);
      if (t.rows.length === 0) continue;
      const docs = t.rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const c of t.columns) {
          const v = row[c.name];
          out[c.name] = c.type === "json" && typeof v === "string" ? JSON.parse(v) : v;
        }
        if (out.id !== undefined) out._id = out.id;
        return out;
      });
      const CHUNK = 2000;
      for (let i = 0; i < docs.length; i += CHUNK) {
        await db.collection(t.name).insertMany(docs.slice(i, i + CHUNK));
      }
    }
  } finally {
    await client.close();
  }
}

function normalize(v: unknown, type: ColType): unknown {
  if (v instanceof Date) return type === "date" ? v.toISOString().slice(0, 10) : v.toISOString();
  return v;
}

function normalizeMysql(v: unknown, type: ColType): unknown {
  if (v instanceof Date) {
    return type === "date"
      ? v.toISOString().slice(0, 10)
      : v.toISOString().slice(0, 23).replace("T", " ");
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}
