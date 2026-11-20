
import { ALL_SHAPES, DATASETS } from "@/services/evals/operator-db-analytics/questions";
import { loadMongo, loadMysql, loadPostgres } from "@/services/evals/operator-db-analytics/fixtures/load";
import { baseUrl, dbUrlFor, evalDbName } from "@/services/evals/operator-db-analytics/env";

const dbNameFor = (shape: string) => `zavi_eval_${shape}`;

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const shapes = only.length > 0 ? only : ALL_SHAPES;

  for (const shape of shapes) {
    const ds = DATASETS[shape]();
    const rowCount = ds.tables.reduce((s, t) => s + t.rows.length, 0);
    console.log(`\n${shape}: ${ds.tables.length} tables, ${rowCount} rows`);

    const pgAdmin = baseUrl("postgres");
    if (pgAdmin) {
      await ensurePostgresDb(pgAdmin, evalDbName(shape));
      await loadPostgres(ds, dbUrlFor("postgres", shape)!);
      console.log(`  postgres  -> ${evalDbName(shape)}`);
    }
    const myAdmin = baseUrl("mysql");
    if (myAdmin) {
      await ensureMysqlDb(myAdmin, evalDbName(shape));
      await loadMysql(ds, dbUrlFor("mysql", shape)!);
      console.log(`  mysql     -> ${evalDbName(shape)}`);
    }
    const mongoBase = baseUrl("mongodb");
    if (mongoBase) {
      await loadMongo(ds, mongoBase, evalDbName(shape));
      console.log(`  mongodb   -> ${evalDbName(shape)}`);
    }
  }
  console.log("\ndone");
}

async function ensurePostgresDb(adminUrl: string, name: string): Promise<void> {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const { rowCount } = await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!rowCount) await c.query(`CREATE DATABASE "${name}"`);
  } finally {
    await c.end();
  }
}

async function ensureMysqlDb(adminUrl: string, name: string): Promise<void> {
  const { createConnection } = await import("mysql2/promise");
  const c = await createConnection(adminUrl);
  try {
    await c.query(`CREATE DATABASE IF NOT EXISTS \`${name}\``);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
