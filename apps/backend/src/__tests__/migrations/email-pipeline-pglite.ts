import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EMAIL_CARD_BOOTSTRAP, EMAIL_CARD_MIGRATIONS } from "./email-card-live-migrations";

export type Db = {
  exec: (q: string) => Promise<unknown>;
  query: <R = Record<string, any>>(q: string, p?: unknown[]) => Promise<{ rows: R[] }>;
  close: () => Promise<void>;
};

export const PGLITE_MODULES = process.env.SITES_SQL_TEST_MODULES;

const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8").replace(/^(begin|commit);$/gm, "");
const loose = (sql: string) => `set check_function_bodies = off;\n${sql}\nset check_function_bodies = on;`;

const BULK = ["20260531071613_comms_safety_net.sql", "20261022120000_bulk_email_own_sender.sql", "20261031190400_email_bulk_freeze_version_bytes.sql"];
const AFTER = ["20261031191100_email_send_results.sql"];

export async function bootEmailPipeline(mine: string[], beforeMigration?: (db: Db, file: string) => Promise<void>): Promise<Db> {
  const { PGlite } = createRequire(resolve(PGLITE_MODULES!, "../package.json"))("@electric-sql/pglite");
  const db = new PGlite() as Db;
  await db.exec(EMAIL_CARD_BOOTSTRAP.replace(/create table if not exists email_lists[^;]*;/, ""));
  await db.exec(`
    alter table decisions add column if not exists handler text;
    alter table decisions add column if not exists agent_run_id uuid;
    alter table channel_actions add column if not exists approval_envelope jsonb;
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid language sql as 'select null::uuid';
    create table comms_unsubscribes (tenant_id uuid, channel text, recipient text);
    create table comms_suppressions (tenant_id uuid, channel text, recipient text, reason text);
    create table tenant_sending_domain (tenant_id uuid primary key, domain text, verification_status text);
    create table tenant_app_setting (tenant_id uuid, key text, value jsonb);
    create table system_config (id int primary key, blob jsonb);
    create or replace function enqueue_ops_alert(a text, b text, c text, d uuid, e text) returns void language sql as 'select null::void';
  `);
  for (const f of BULK) await db.exec(loose(read(f)));
  for (const f of EMAIL_CARD_MIGRATIONS) await db.exec(loose(read(f)));
  for (const f of AFTER) await db.exec(loose(read(f)));
  for (const f of mine) {
    await beforeMigration?.(db, f);
    await db.exec(read(f));
  }
  return db;
}

export async function attempt(db: Db, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query("begin");
    await db.query(sql, params);
    await db.query("commit");
    return null;
  } catch (e) {
    await db.query("rollback").catch(() => undefined);
    return (e as Error).message;
  }
}
