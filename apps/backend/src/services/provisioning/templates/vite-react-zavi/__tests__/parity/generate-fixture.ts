
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shardCollectionRow, siteContractRow, validateManifest } from "../../manifest";
import { MANIFEST, MEMBERS, SITE, VALIDATOR_CASES } from "./scenarios";
import { CALLERS_V2, MANIFEST_V2, MEMBERS_V2, SITE_V2, STEPS_V2 } from "./scenarios-v2";
import { replay, type Caller, type Engine } from "./replay";

const V2 = process.argv.includes("--v2");
const site = V2 ? SITE_V2 : SITE;

const PGBIN = process.env.PGBIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const PORT = process.env.PORT ?? "55463";
const MIG = process.env.SHARD_MIGRATIONS;
if (!MIG) throw new Error("SHARD_MIGRATIONS=<infra/site-shard/migrations dir> is required");

const dir = mkdtempSync(join(tmpdir(), "zavi-parity-"));
const run = (cmd: string, args: string[], input?: string) => {
  const r = spawnSync(cmd, args, { input, encoding: "utf-8", env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" } });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};
const psql = (user: string, sql: string) =>
  run(`${PGBIN}/psql`, ["-h", dir, "-p", PORT, "-d", "postgres", "-U", user, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"], sql);
const su = (sql: string) => {
  const r = psql("postgres", sql);
  if (r.code !== 0) throw new Error(`setup failed: ${r.err}`);
  return r.out;
};
const lit = (v: unknown) => `$zj$${JSON.stringify(v)}$zj$::jsonb`;
const txt = (v: string | null) => (v === null ? "null" : `$zk$${v}$zk$`);

function request(caller: Caller, call: string): unknown {
  const claims = caller.sub
    ? { role: "authenticated", site_id: site, sub: caller.sub, site_role: caller.siteRole }
    : { role: "anon", site_id: site };
  const r = psql("authenticator", [
    "\\set VERBOSITY terse",
    "begin;",
    `set local role ${caller.sub ? "authenticated" : "anon"};`,
    `set local "request.jwt.claims" = '${JSON.stringify(claims)}';`,
    `select (${call})::text;`,
    "commit;",
  ].join("\n"));
  if (r.code !== 0) {
    const line = r.err.split("\n").find((l) => l.includes("ERROR")) ?? r.err;
    throw new Error(line.replace(/^.*ERROR:\s+/, ""));
  }
  return r.out === "" ? null : JSON.parse(r.out);
}

const sqlEngine: Engine = {
  create: async (c, col, data, key) => request(c, `api.create_record(${txt(col)}, ${lit(data)}, ${txt(key)})`),
  get: async (c, col, id) => request(c, `api.get_record(${txt(col)}, ${txt(id)}::uuid)`),
  list: async (c, col, filter, limit, cursor, sort) =>
    request(c, `api.list_records(${txt(col)}, ${lit(filter)}, ${limit === null ? "50" : String(limit)}, ${txt(cursor)}, ${txt(sort)})`),
  update: async (c, col, id, patch) => request(c, `api.update_record(${txt(col)}, ${txt(id)}::uuid, ${lit(patch)})`),
  delete: async (c, col, id) => request(c, `api.delete_record(${txt(col)}, ${txt(id)}::uuid)`),
  transition: async (c, col, id, to) => request(c, `api.transition_record(${txt(col)}, ${txt(id)}::uuid, ${txt(to)})`),
  action: async (c, name, target, record, data, key) =>
    request(c, `api.run_action(${txt(name)}, ${txt(target)}::uuid, ${txt(record)}::uuid, ${lit(data)}, ${txt(key)})`),
  aggregate: async (c, name, filter) => request(c, `api.aggregate(${txt(name)}, ${lit(filter)})`),
};

async function main() {
  const init = run(`${PGBIN}/initdb`, ["-D", join(dir, "data"), "-U", "postgres", "-A", "trust"]);
  if (init.code !== 0) throw new Error(init.err);
  const start = run(`${PGBIN}/pg_ctl`, ["-D", join(dir, "data"), "-o", `-p ${PORT} -k ${dir} -c listen_addresses=''`, "-l", join(dir, "log"), "-w", "start"]);
  if (start.code !== 0) throw new Error(start.err);
  try {
    su(`
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
  name text not null, owner uuid, owner_id text, metadata jsonb, created_at timestamptz default now(),
  updated_at timestamptz default now(), unique (bucket_id, name));
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;`);
    const files = readdirSync(MIG as string).filter((f) => /^0\d+_.*\.sql$/.test(f)).sort();
    const hash = createHash("sha256");
    for (const f of files) {
      const sql = readFileSync(join(MIG as string, f), "utf-8");
      hash.update(f).update(sql);
      su(sql);
    }

    const canon = validateManifest(V2 ? MANIFEST_V2 : MANIFEST);
    if (!canon.ok) throw new Error(JSON.stringify(canon.issues));
    const rows = Object.entries(canon.value.collections).map(([name, c]) => shardCollectionRow(name, c));
    const members = V2 ? MEMBERS_V2 : MEMBERS;
    const v2cols = (r: ReturnType<typeof shardCollectionRow>) =>
      V2 ? `, ${r.recipient === null ? "null" : lit(r.recipient)}, ${lit(r.uniques)}, ${r.states === null ? "null" : lit(r.states)}, ${lit(r.references)}` : "";
    const contract = siteContractRow(canon.value);
    su([
      "begin;",
      `insert into zsite.sites (site_id) values ('${site}');`,
      ...(V2 ? [`insert into zsite.site_contracts (site_id, schema_version, roles, capabilities, actions, aggregates) values ('${site}', ${contract.schema_version}, ${lit(contract.roles)}, ${lit(contract.capabilities)}, ${lit(contract.actions)}, ${lit(contract.aggregates)});`] : []),
      ...rows.map((r) => `insert into zsite.collections (site_id, name, kind, rules, schema, fields, indexes${V2 ? ', recipient, uniques, states, "references"' : ""}) values ('${site}', '${r.name}', '${r.kind}', ${lit(r.rules)}, ${lit(r.schema)}, ${lit(r.fields)}, ${lit(r.indexes)}${v2cols(r)});`),
      ...members.map((m, i) => `insert into zsite.identities (site_id, email_norm, auth_user_id, alias) values ('${site}', 'm${i}@x.test', '${m.id}', 'alias-${i}');`),
      ...members.map((m) => `insert into zsite.members (site_id, user_id, role, status) values ('${site}', '${m.id}', '${m.role}', '${m.status ?? "active"}');`),
      "commit;",
    ].join("\n"));

    if (V2) {
      const steps = await replay(sqlEngine, STEPS_V2, CALLERS_V2);
      const out = { generated_from: { migrations: files, sha256: hash.digest("hex") }, steps };
      writeFileSync(join(__dirname, "fixture-v2.json"), JSON.stringify(out, null, 1) + "\n");
      console.log(`fixture-v2.json: ${steps.length} steps (${steps.filter((x) => !x.ok).length} refusals)`);
      return;
    }
    const steps = await replay(sqlEngine);

    const validator = VALIDATOR_CASES.map((v) => {
      const r = psql("postgres", `begin; insert into zsite.collections (site_id, name, kind, rules, schema, fields, indexes) values ('${SITE}', 'v_${v.name}', '${v.kind ?? "records"}', ${lit(v.rules)}, ${lit(v.schema ?? {})}, ${lit(v.fields ?? {})}, '{}'::jsonb); rollback;`);
      return { name: v.name, sql_accepts: r.code === 0 };
    });

    const out = { generated_from: { migrations: files, sha256: hash.digest("hex") }, steps, validator };
    writeFileSync(join(__dirname, "fixture.json"), JSON.stringify(out, null, 1) + "\n");
    console.log(`fixture.json: ${steps.length} steps (${steps.filter((s) => !s.ok).length} refusals), ${validator.length} validator cases`);
  } finally {
    run(`${PGBIN}/pg_ctl`, ["-D", join(dir, "data"), "-m", "immediate", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
