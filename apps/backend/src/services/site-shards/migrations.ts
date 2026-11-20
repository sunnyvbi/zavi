
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ShardSql } from "./contract";
import { FROZEN_FILE, FROZEN_VERSIONS, concurrentIndexOf, lintShardMigration, parseDirectives, runnerSteps } from "./migration-protocol";
import type { ShardMigrationChecksums } from "./registry";
import { nameLit, textLit } from "./sql";

export type ShardMigrationFile = { version: string; sql: string; sha256: string };

export const SHARD_MIGRATION_VERSION_RE = /^[0-9]{4}_[a-z0-9_]{1,60}$/;

export function defaultShardSqlRoot(env: Record<string, string | undefined> = process.env): string {
  const override = (env.SITE_SHARD_SQL_DIR ?? "").trim();
  if (override) return override;
  const candidates = [resolve(__dirname, "../../../../../infra/site-shard"), resolve(__dirname, "../../../../../../infra/site-shard")];
  return candidates.find((c) => existsSync(join(c, "migrations"))) ?? candidates[0];
}

export function loadShardMigrations(root: string = defaultShardSqlRoot()): ShardMigrationFile[] {
  const out: ShardMigrationFile[] = [];
  for (const sub of ["migrations", "auth"]) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".sql")) continue;
      const version = f.slice(0, -4);
      if (!SHARD_MIGRATION_VERSION_RE.test(version)) throw new Error(`shard migration ${sub}/${f}: name must be NNNN_name.sql`);
      const sql = readFileSync(join(dir, f), "utf8");
      out.push({ version, sql, sha256: createHash("sha256").update(sql).digest("hex") });
    }
  }
  if (!out.length) throw new Error(`no shard schema SQL under ${root} (set SITE_SHARD_SQL_DIR, or ship infra/site-shard)`);
  out.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  for (let i = 1; i < out.length; i++) {
    if (out[i].version.slice(0, 4) === out[i - 1].version.slice(0, 4)) {
      throw new Error(`shard migrations ${out[i - 1].version} and ${out[i].version} share a number`);
    }
  }
  assertProtocol(out, readFrozen(root));
  return out;
}

export function readFrozen(root: string): Record<string, string> {
  const f = join(root, "migrations", FROZEN_FILE);
  if (!existsSync(f)) return {};
  const d = JSON.parse(readFileSync(f, "utf8")) as { files?: Record<string, string> };
  return d.files && typeof d.files === "object" ? d.files : {};
}

export function assertProtocol(files: ShardMigrationFile[], frozen: Record<string, string>): void {
  const versions = files.map((f) => f.version);
  const problems: string[] = [];
  for (const f of files) {
    if (FROZEN_VERSIONS.includes(f.version) && frozen[f.version] !== undefined) {
      if (frozen[f.version] !== f.sha256) problems.push(`${f.version}: frozen file changed (never edit an applied migration; add a new file)`);
      continue;
    }
    const prior = files.filter((x) => x.version < f.version).map((x) => x.sql);
    for (const v of lintShardMigration(f, versions, prior)) problems.push(`${f.version}: ${v}`);
  }
  if (problems.length) throw new Error(`shard migration protocol:\n  ${problems.join("\n  ")}`);
}

export async function readLedger(sql: ShardSql, ref: string): Promise<Set<string>> {
  const present = (await sql.query(ref, "select to_regclass('zsite.migrations') is not null as present")) as Array<{ present?: boolean }>;
  if (present[0]?.present !== true) return new Set();
  const rows = (await sql.query(ref, "select version from zsite.migrations")) as Array<{ version?: unknown }>;
  return new Set(rows.map((r) => String(r.version ?? "")).filter(Boolean));
}

export function pendingMigrations(files: ShardMigrationFile[], ledger: Set<string>): ShardMigrationFile[] {
  return files.filter((f) => !ledger.has(f.version));
}

export async function applyShardMigration(sql: ShardSql, ref: string, file: ShardMigrationFile): Promise<void> {
  if (!SHARD_MIGRATION_VERSION_RE.test(file.version)) throw new Error("invalid shard migration version");
  for (const step of runnerSteps(file)) {
    const idx = concurrentIndexOf(step);
    if (!idx) {
      await sql.query(ref, step);
      continue;
    }
    await dropInvalidIndex(sql, ref, idx.schema, idx.name);
    await sql.query(ref, step);
    if (await invalidIndex(sql, ref, idx.schema, idx.name)) {
      await dropInvalidIndex(sql, ref, idx.schema, idx.name).catch(() => undefined);
      throw new Error(`index ${idx.name} was built INVALID (concurrent build failed; dropped); the next run rebuilds it`);
    }
  }
  await recordShardMigration(sql, ref, file);
}

async function invalidIndex(sql: ShardSql, ref: string, schema: string, name: string): Promise<boolean> {
  const rows = (await sql.query(
    ref,
    `select n.nspname as schema from pg_catalog.pg_index i
       join pg_catalog.pg_class c on c.oid = i.indexrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where c.relname = ${nameLit(name)} and n.nspname = ${nameLit(schema)} and not i.indisvalid`,
  )) as Array<{ schema?: unknown }>;
  return rows.length > 0;
}

async function dropInvalidIndex(sql: ShardSql, ref: string, schema: string, name: string): Promise<void> {
  if (await invalidIndex(sql, ref, schema, name)) await sql.query(ref, `drop index concurrently if exists "${schema}"."${name}"`);
}

export const contractAfterOf = (file: ShardMigrationFile): string | null => parseDirectives(file.sql).contractAfter;

export async function recordShardMigration(sql: ShardSql, ref: string, file: ShardMigrationFile): Promise<void> {
  const has = (await sql.query(ref, "select to_regprocedure('zsite.record_migration(text,text)') is not null as ok")) as Array<{ ok?: boolean }>;
  if (has[0]?.ok === true) {
    await sql.query(ref, `select zsite.record_migration(${textLit(file.version)}, ${textLit(file.sha256)})`);
  } else {
    await sql.query(ref, `insert into zsite.migrations (version) values (${textLit(file.version)}) on conflict do nothing`);
  }
}

export type ApplyResult = { pending: string[]; applied: string[]; failed?: { version: string; error: string } };

export async function applyPendingMigrations(
  sql: ShardSql,
  ref: string,
  files: ShardMigrationFile[],
  opts: { dryRun?: boolean; checksums?: { shard_id: string; store: ShardMigrationChecksums } } = {},
): Promise<ApplyResult> {
  const ledger = await readLedger(sql, ref);
  const pending = pendingMigrations(files, ledger);
  const result: ApplyResult = { pending: pending.map((f) => f.version), applied: [] };
  if (opts.dryRun) return result;
  for (const f of files.filter((x) => ledger.has(x.version))) {
    try {
      await recordShardMigration(sql, ref, f);
    } catch (e) {
      result.failed = { version: f.version, error: `checksum mismatch on the shard: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
      return result;
    }
  }
  const ck = opts.checksums;
  if (ck) {
    for (const f of files.filter((x) => ledger.has(x.version))) {
      const onRecord = await ck.store.record(ck.shard_id, f.version, f.sha256);
      if (onRecord !== f.sha256) {
        result.failed = { version: f.version, error: "checksum mismatch: the file changed after it was applied (add a new file instead)" };
        return result;
      }
    }
  }
  for (const f of pending) {
    try {
      await applyShardMigration(sql, ref, f);
      if (ck) await ck.store.record(ck.shard_id, f.version, f.sha256);
      result.applied.push(f.version);
    } catch (e) {
      result.failed = { version: f.version, error: String((e as Error)?.message ?? e).slice(0, 300) };
      return result;
    }
  }
  return result;
}

export function latestVersion(files: ShardMigrationFile[]): string | null {
  return files.length ? files[files.length - 1].version : null;
}
