#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
for (const oid of [1082, 1083, 1114, 1184, 1266]) pg.types.setTypeParser(oid, (v) => v);
import "./_supabase-script-client.mjs";
import { createClient } from "@supabase/supabase-js";
import {
  BUDGET,
  assertProdSource,
  carriedFamilies,
  connectorFamily,
  connectorKept,
  insertableColumns,
  parseEnvText,
  parsePgUri,
  pickActiveTenant,
  planTable,
  resolveMirrorTarget,
  schemaMismatches,
  scrubConfigBlob,
  secretAllowed,
  fkRepair,
  PRESERVE_FOREVER,
  syncAuthHooks,
  activeTenantClaim,
  planCreatorCopy,
  CREATOR_TABLES,
} from "./mirror/plan.mjs";

const BATCH = 500;
const LOGIN_EMAIL = (process.env.MIRROR_LOGIN_EMAIL || "developer@zaviagent.com").toLowerCase();
const RAVI_EMAIL = "rravi149@gmail.com";
const ARG = new Set(process.argv.slice(2));
const PLAN_ONLY = ARG.has("--plan-only");
const CA = readFileSync(new URL("./mirror/supabase-ca-2021.crt", import.meta.url), "utf8");
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const STARTED = Date.now();
const BANNED = "876000h";

const log = (...a) => console.log("[mirror]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timedFetch = (input, init = {}) => fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(60_000) });
const apiClient = (url, key) => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch } });
const pgConfig = (uri, extra = {}) => ({
  ...parsePgUri(uri),
  ssl: { rejectUnauthorized: true, ca: CA },
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  connectionTimeoutMillis: 30_000,
  query_timeout: 660_000,
  ...extra,
});
const INSERT_MAX_BYTES = 4_000_000;
const isClientTimeout = (e) => /query read timeout|timeout exceeded when trying to connect/i.test(String(e?.message ?? ""));
const q = (id) => `"${String(id).replace(/"/g, '""')}"`;
const readEnvFile = (path) => parseEnvText(readFileSync(path, "utf8"));

function checkBudget(extra = "") {
  if (Date.now() - STARTED > BUDGET.maxMinutes * 60_000) throw new Error(`time budget (${BUDGET.maxMinutes} min) exceeded ${extra}`.trim());
}

async function budgetStatement(client, capMs, extra) {
  checkBudget(extra);
  const left = BUDGET.maxMinutes * 60_000 - (Date.now() - STARTED);
  await client.query(`set local statement_timeout = ${Math.max(1000, Math.min(capMs, left))}`);
}

async function main() {
  if (ARG.has("--activity")) {
    const env = readEnvFile(`${homedir()}/.zavi/mirror.env`);
    resolveMirrorTarget({ apiUrl: env.MIRROR_SUPABASE_URL, dbUri: env.MIRROR_DB_URL, expectedRef: env.MIRROR_PROJECT_REF });
    const c = new pg.Client(pgConfig(env.MIRROR_DB_URL));
    await c.connect();
    const { rows } = await c.query(
      `select pid, state, wait_event_type, wait_event, now() - xact_start as xact_age, now() - query_start as query_age,
              split_part(ltrim(query), ' ', 1) || ' ' || coalesce(substring(query from '(?i)(?:into|from|update)\\s+(\\S+)'), '') as statement
         from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'
        order by xact_start nulls last`,
    );
    console.table(rows);
    return c.end();
  }
  const mirEnv = PLAN_ONLY ? {} : readEnvFile(`${homedir()}/.zavi/mirror.env`);
  let ref = null;
  if (!PLAN_ONLY) {
    for (const k of ["MIRROR_PROJECT_REF", "MIRROR_SUPABASE_URL", "MIRROR_SERVICE_ROLE_KEY", "MIRROR_DB_URL"]) {
      if (!mirEnv[k]) throw new Error(`~/.zavi/mirror.env is missing ${k}`);
    }
    ref = resolveMirrorTarget({ apiUrl: mirEnv.MIRROR_SUPABASE_URL, dbUri: mirEnv.MIRROR_DB_URL, expectedRef: mirEnv.MIRROR_PROJECT_REF });
  }
  if (ARG.has("--check-target")) return log(`target ok: mirror project ${ref}`);
  if (ARG.has("--migrate")) return migrate(mirEnv, ref);

  for (const k of ["DEV_LOGIN_PASSWORD", "MIRROR_RAVI_PASSWORD"]) if (!PLAN_ONLY && !mirEnv[k]) throw new Error(`~/.zavi/mirror.env is missing ${k}`);
  const prodEnv = readEnvFile(`${homedir()}/.zavi/prodqa.env`);
  const prodRoUri = execFileSync("security", ["find-generic-password", "-a", process.env.USER, "-s", "zavi-prod-db-ro", "-w"], { encoding: "utf8" }).trim();
  assertProdSource({ apiUrl: prodEnv.SUPABASE_URL, dbUri: prodRoUri });
  const prodApi = apiClient(prodEnv.SUPABASE_URL, prodEnv.SUPABASE_SERVICE_ROLE_KEY);

  const dev = await findDevUser(prodApi, mirEnv.MIRROR_DEV_USER_ID);

  const prod = new pg.Client(pgConfig(prodRoUri, { options: "-c default_transaction_read_only=on -c statement_timeout=15000" }));
  await prod.connect();
  await prod.query("begin isolation level repeatable read read only");
  await prod.query("set local statement_timeout = '60s'");
  const tenantIds = (await prod.query("select tenant_id from tenant_users where user_id = $1 order by tenant_id", [dev.id])).rows.map((r) => r.tenant_id);
  if (!tenantIds.length && PLAN_ONLY) throw new Error(`${LOGIN_EMAIL} is not a member of any company in prod.`);
  if (!tenantIds.length) log(`${LOGIN_EMAIL} is in no company in prod: the mirror will be emptied`);
  log(`companies in scope (${LOGIN_EMAIL}): ${tenantIds.join(", ")}`);

  const prodCols = await columns(prod);
  const plans = [];
  let plannedRows = 0;
  let plannedBytes = 0;
  for (const [table, cols] of prodCols) {
    checkBudget("while planning; nothing written");
    const names = cols.map((c) => c.column_name);
    if (!names.includes("tenant_id")) continue;
    const pre = planTable(table, names, 1);
    if (pre.action === "skip") {
      plans.push({ table, cols, n: null, ...pre });
      continue;
    }
    const n = Number((await prod.query(`select count(*) as n from public.${q(table)} where tenant_id = any($1)`, [tenantIds])).rows[0].n);
    const p = planTable(table, names, n);
    let rows = n;
    if (p.action === "copy" && p.sinceDays) {
      rows = Number((await prod.query(`select count(*) as n from public.${q(table)} where tenant_id = any($1) and ${q(p.sinceColumn)} > now() - make_interval(days => $2)`, [tenantIds, p.sinceDays])).rows[0].n);
    }
    let bytes = 0;
    if (p.action === "copy" && rows) {
      const { rows: [s] } = await prod.query(
        "select pg_total_relation_size(c.oid)::float8 / greatest(c.reltuples, 1) as avg from pg_class c where c.oid = ('public.' || quote_ident($1))::regclass",
        [table],
      );
      bytes = Math.round(rows * Number(s.avg));
    }
    if (p.action === "copy") {
      plannedRows += rows;
      plannedBytes += bytes;
    }
    plans.push({ table, cols, n, rows, bytes, ...p });
  }
  const toCopy = plans.filter((p) => p.action === "copy");
  const mb = (b) => `${Math.round(b / 1e6)} MB`;
  log(`${toCopy.length} tables to copy (${plannedRows} rows, about ${mb(plannedBytes)}), ${plans.length - toCopy.length} tenant tables skipped`);
  if (plannedRows > BUDGET.maxRows) throw new Error(`planned ${plannedRows} rows exceeds the ${BUDGET.maxRows}-row budget; nothing written`);
  if (plannedBytes > BUDGET.maxBytes) {
    const top = [...toCopy].sort((a, b) => b.bytes - a.bytes).slice(0, 8).map((p) => `${p.table} ${mb(p.bytes)}`).join(", ");
    throw new Error(`planned copy is about ${mb(plannedBytes)}, over the ${mb(BUDGET.maxBytes)} budget (the free mirror holds ~500 MB); biggest: ${top}. Nothing written`);
  }
  if (PLAN_ONLY) {
    for (const p of [...toCopy].sort((a, b) => b.bytes - a.bytes)) log(`copy ${p.table} (${p.rows}${p.sinceDays ? ` of ${p.n}, last ${p.sinceDays}d by ${p.sinceColumn}` : ""}, ~${mb(p.bytes)})`);
    const notListed = plans.filter((p) => p.reason === "not on the mirror allowlist").map((p) => p.table);
    log(`not on the allowlist (${notListed.length}): ${notListed.join(", ")}`);
    await prod.query("rollback");
    return prod.end();
  }

  const mirApi = apiClient(mirEnv.MIRROR_SUPABASE_URL, mirEnv.MIRROR_SERVICE_ROLE_KEY);
  const mir = new pg.Client(pgConfig(mirEnv.MIRROR_DB_URL));
  await mir.connect();
  const marker = (await mir.query("select * from public._zavi_mirror where id = 1").catch(() => ({ rows: [] }))).rows[0];
  if (!marker || marker.project_ref !== ref) throw new Error("mirror marker missing or for another project. Run: scripts/mirror-upcar.sh migrate");
  if (!Array.isArray(marker.creator_ids)) throw new Error("mirror marker has no creator manifest yet. Run: scripts/mirror-upcar.sh migrate");
  const mirCols = await columns(mir);
  const touched = ["tenants", "tenant_users", "profiles", "secrets", "connector_metadata", "tenant_mcp_servers", "system_config", ...CREATOR_TABLES, ...toCopy.map((p) => p.table)];
  const bad = schemaMismatches(prodCols, mirCols, [...new Set(touched)], await enums(prod), await enums(mir));
  if (bad.length) throw new Error(`mirror schema is behind prod; run scripts/mirror-upcar.sh migrate from an up-to-date origin/main checkout:\n  ${bad.join("\n  ")}`);
  log("schema matches prod; checking the mirror's Vault");
  await preflightVault(mir);

  const members = (await prod.query("select * from tenant_users where tenant_id = any($1) order by user_id, tenant_id", [tenantIds])).rows;
  const memberIds = [...new Set(members.map((m) => m.user_id))];
  const memberships = new Map();
  for (const m of members) memberships.set(m.user_id, [...(memberships.get(m.user_id) ?? []), m.tenant_id]);
  const profiles = (await prod.query("select * from profiles where user_id = any($1)", [memberIds])).rows;
  const tenantCols = insertableColumns(prodCols.get("tenants"));
  const tenants = (await prod.query(`select ${tenantCols.map(q).join(", ")} from tenants where id = any($1)`, [tenantIds])).rows;
  const secretKeys = (await prod.query("select tenant_id, key from secrets where tenant_id = any($1) order by tenant_id, key", [tenantIds])).rows;
  const cfg = (await prod.query("select blob from system_config where id = 1")).rows[0];
  const creatorCols = insertableColumns(prodCols.get("human_members"));
  const handleCols = insertableColumns(prodCols.get("human_member_handles"));
  const packageCols = insertableColumns(prodCols.get("creator_packages"));
  const creatorRows = (await prod.query(
    `select ${creatorCols.map(q).join(", ")} from public.human_members where vetting_state = 'approved' and creator_payout_country_supported(country_code) order by id`,
  )).rows;
  const creatorIds = creatorRows.map((c) => c.id);
  const bench = planCreatorCopy({
    creators: creatorRows,
    handles: (await prod.query(`select ${handleCols.map(q).join(", ")} from public.human_member_handles where human_member_id = any($1)`, [creatorIds])).rows,
    packages: (await prod.query(`select ${packageCols.map(q).join(", ")} from public.creator_packages where human_member_id = any($1) and active`, [creatorIds])).rows,
    memberIds,
    prevCreatorIds: marker.creator_ids,
  });
  log(`creators: ${bench.creators.length} approved and payable, ${bench.handles.length} handles, ${bench.packages.length} active packages (all creator columns; creator-only logins get placeholder emails, sign-in blocked)`);

  log(`reading ${secretKeys.length} connector secret(s) from prod`);
  const secrets = [];
  const leftOut = [];
  const failedFamilies = new Set();
  for (const { tenant_id, key } of secretKeys) {
    checkBudget("while reading secrets; nothing written");
    if (!secretAllowed(key)) {
      leftOut.push(key);
      continue;
    }
    const { data, error } = await prodApi.rpc("get_secret", { p_tenant_id: tenant_id, p_key: key });
    if (error || data == null) {
      failedFamilies.add(`${tenant_id}:${connectorFamily(key)}`);
      leftOut.push(`${key} (read failed)`);
      continue;
    }
    secrets.push({ tenant_id, key, value: String(data) });
  }
  const carried = secrets.filter((s) => !failedFamilies.has(`${s.tenant_id}:${connectorFamily(s.key)}`));
  const familiesByTenant = new Map(tenantIds.map((t) => [t, carriedFamilies(carried.filter((s) => s.tenant_id === t).map((s) => s.key))]));

  log(`reading ${memberIds.length} member login(s) from prod`);
  const memberUsers = new Map();
  for (const id of memberIds) {
    checkBudget("while reading members; nothing written");
    const { data, error } = await prodApi.auth.admin.getUserById(id);
    if (error || !data?.user) throw new Error(`prod user ${id} (a member) could not be read: ${error?.message ?? "missing"}`);
    memberUsers.set(id, data.user);
  }
  const ravi = [...memberUsers.values()].find((u) => u.email?.toLowerCase() === RAVI_EMAIL) ?? null;
  const prevTenants = marker.tenant_ids ?? [];
  const prevUsers = marker.user_ids ?? [];
  const pendingStorage = [...new Set([...(marker.pending_storage_tenants ?? []), ...prevTenants.filter((t) => !tenantIds.includes(t))])];
  const wipeTenants = [...new Set([...prevTenants, ...tenantIds])];
  const summary = [];
  let copiedRows = 0;
  let orphans = { placeholders: 0, placeholderIds: [], nulled: 0, dropped: 0, droppedBy: {} };
  const createdUsers = [];
  let began = false;
  let committing = false;
  let cleanupDb = mir;
  try {
    log("reclaiming space from earlier runs");
    const sizeNow = await reclaimSpace(mir, [...mirCols.keys()]);
    const peak = sizeNow + plannedBytes + BUDGET.dbMarginBytes;
    if (peak > BUDGET.maxDatabaseBytes) {
      throw new Error(`the mirror is ${Math.round(sizeNow / 1e6)} MB and the copy needs about ${Math.round(plannedBytes / 1e6)} MB more while the old copy is kept until commit; that passes the ${Math.round(BUDGET.maxDatabaseBytes / 1e6)} MB limit. Nothing written`);
    }
    for (const [id, u] of memberUsers) {
      checkBudget("while creating logins; nothing committed");
      const enabled = id === dev.id || id === ravi?.id;
      const pw = id === dev.id ? mirEnv.DEV_LOGIN_PASSWORD : id === ravi?.id ? mirEnv.MIRROR_RAVI_PASSWORD : randomBytes(24).toString("base64url");
      if (await ensureAuthUser(mirApi, u, pw, enabled)) createdUsers.push(id);
    }
    for (const login of bench.logins) {
      checkBudget("while creating creator logins; nothing committed");
      if (await ensureCreatorLogin(mirApi, login)) createdUsers.push(login.id);
    }
    log("logins ready; copying");
    await mir.query("begin");
    began = true;
    await mir.query("set local statement_timeout = '600s'");
    await prod.query("set local statement_timeout = '60s'");
    await mir.query("set local session_replication_role = replica");
    await mir.query("delete from vault.secrets where id in (select vault_secret_id from public.secrets where tenant_id = any($1))", [wipeTenants]);
    const tenantFks = (await foreignKeys(mir, [...mirCols.keys()])).filter((fk) => fk.parent === "tenants" && fk.cols.length === 1 && fk.cols[0] === "tenant_id");
    const detachOnDelete = new Set(tenantFks.filter((fk) => fk.rule === "n").map((fk) => fk.child));
    const setDefault = tenantFks.find((fk) => fk.rule === "d");
    if (setDefault) throw new Error(`ON DELETE SET DEFAULT on ${setDefault.child}.tenant_id is not supported; nothing committed`);
    const leaving = prevTenants.filter((t) => !tenantIds.includes(t));
    for (const table of PRESERVE_FOREVER) {
      if (mirCols.has(table) && !detachOnDelete.has(table)) throw new Error(`${table} must keep its rows but its tenant FK is not ON DELETE SET NULL; nothing committed`);
    }
    for (const [table, cols] of mirCols) {
      if (table === "_zavi_mirror" || !cols.some((c) => c.column_name === "tenant_id")) continue;
      await budgetStatement(mir, 600_000, "while wiping; nothing committed");
      if (PRESERVE_FOREVER.has(table)) {
        await mir.query(`update public.${q(table)} set tenant_id = null where tenant_id = any($1)`, [wipeTenants]);
      } else if (detachOnDelete.has(table)) {
        if (leaving.length) await mir.query(`update public.${q(table)} set tenant_id = null where tenant_id = any($1)`, [leaving]);
        await mir.query(`delete from public.${q(table)} where tenant_id = any($1)`, [tenantIds]);
      } else {
        await mir.query(`delete from public.${q(table)} where tenant_id = any($1)`, [wipeTenants]);
      }
    }
    await mir.query("delete from public.tenants where id = any($1)", [wipeTenants]);
    await mir.query("delete from public.profiles where user_id = any($1)", [[...new Set([...prevUsers, ...memberIds])]]);
    await cascadeByHand(mir, mirCols);
    const upsertKeys = new Map();
    for (const p of toCopy) if (detachOnDelete.has(p.table)) upsertKeys.set(p.table, await primaryKey(mir, p.table));

    await insertRows(mir, "tenants", tenantCols, tenants);
    for (const p of toCopy) {
      await budgetStatement(mir, 120_000, "while copying; nothing committed");
      const cols = insertableColumns(p.cols);
      const colList = cols.map(q).join(", ");
      const where = p.sinceDays ? `tenant_id = any($1) and ${q(p.sinceColumn)} > now() - make_interval(days => ${Number(p.sinceDays)})` : "tenant_id = any($1)";
      await prod.query(`declare cur no scroll cursor for select ${colList} from public.${q(p.table)} where ${where}`, [tenantIds]);
      let copied = 0;
      for (;;) {
        const { rows } = await prod.query(`fetch ${BATCH} from cur`);
        if (!rows.length) break;
        await insertRows(mir, p.table, cols, rows, upsertKeys.get(p.table));
        copied += rows.length;
        copiedRows += rows.length;
        if (copiedRows > BUDGET.maxRows) throw new Error(`row budget (${BUDGET.maxRows}) exceeded; nothing committed`);
        checkBudget("while copying; nothing committed");
        await sleep(20);
      }
      await prod.query("close cur");
      summary.push([p.table, copied]);
      if (summary.length % 25 === 0 || summary.length === toCopy.length) log(`copied ${summary.length}/${toCopy.length} tables (${copiedRows} rows)`);
    }

    log("copying members, logins and connector secrets");
    await insertRows(mir, "tenant_users", insertableColumns(prodCols.get("tenant_users")), members);
    const profileRows = profiles.map((p) => ({ ...p, active_tenant_id: pickActiveTenant(p.active_tenant_id, memberships.get(p.user_id) ?? []) }));
    await insertRows(mir, "profiles", insertableColumns(prodCols.get("profiles")), profileRows);
    log(`copying ${bench.creators.length} creators`);
    await mir.query("delete from public.creator_packages where human_member_id = any($1)", [bench.wipeIds]);
    await mir.query("delete from public.human_member_handles where human_member_id = any($1)", [bench.wipeIds]);
    await mir.query("delete from public.human_members where id = any($1)", [bench.wipeIds]);
    await insertRows(mir, "human_members", creatorCols, bench.creators);
    await insertRows(mir, "human_member_handles", handleCols, bench.handles);
    await insertRows(mir, "creator_packages", packageCols, bench.packages);

    await mir.query("savepoint nolog");
    try {
      await mir.query("set local log_statement = 'none'");
      await mir.query("set local log_min_duration_statement = -1");
      await mir.query("release savepoint nolog");
    } catch {
      await mir.query("rollback to savepoint nolog");
      await mir.query("release savepoint nolog");
    }
    const logCfg = (await mir.query(
      "select current_setting('log_statement') as ls, current_setting('log_min_duration_statement') as lm",
    )).rows[0];
    if (!["none", "ddl"].includes(logCfg.ls) || logCfg.lm !== "-1") {
      throw new Error(`mirror logs statements (log_statement=${logCfg.ls}, log_min_duration_statement=${logCfg.lm}); refusing to write plaintext secrets. Set both to none / -1 on the mirror project.`);
    }
    for (const s of carried) {
      const { rows } = await mir.query("select vault.create_secret($1, $2) as id", [s.value, `mirror:${s.tenant_id}:${s.key}:${randomBytes(4).toString("hex")}`]);
      await mir.query("insert into public.secrets (tenant_id, key, vault_secret_id) values ($1, $2, $3)", [s.tenant_id, s.key, rows[0].id]);
    }
    const removedBy = {};
    for (const [table, col] of [["connector_metadata", "slug"], ["tenant_mcp_servers", "server_id"]]) {
      const { rows } = await mir.query(`select distinct tenant_id, ${q(col)} as id from public.${q(table)} where tenant_id = any($1)`, [tenantIds]);
      for (const r of rows) {
        if (!connectorKept(r.id, familiesByTenant.get(r.tenant_id) ?? new Set())) {
          const res = await mir.query(`delete from public.${q(table)} where tenant_id = $1 and ${q(col)} = $2`, [r.tenant_id, r.id]);
          removedBy[table] = (removedBy[table] ?? 0) + (res.rowCount ?? 0);
        }
      }
    }

    await mir.query("update public.tenant_agent_schedules set enabled = false where tenant_id = any($1)", [tenantIds]);
    await mir.query("update public.custom_agent_triggers set enabled = false where tenant_id = any($1)", [tenantIds]);
    await mir.query("update public.agent_runs set status = 'cancelled' where tenant_id = any($1) and status in ('queued', 'running')", [tenantIds]);

    if (cfg) {
      await mir.query(
        "insert into public.system_config (id, blob) values (1, $1::jsonb) on conflict (id) do update set blob = excluded.blob",
        [JSON.stringify(scrubConfigBlob(cfg.blob))],
      );
    }
    log(`fixing references to rows outside the copy (${summary.length} tables, up to 6 passes)`);
    orphans = await repairOrphans(mir, prodApi, mirApi, summary.map(([t]) => t), tenantIds, createdUsers, new Set(memberIds));
    await bumpSequences(mir, ["tenants", ...summary.map(([t]) => t)]);
    await mir.query(
      "update public._zavi_mirror set tenant_ids = $1, user_ids = $2, pending_storage_tenants = $3, creator_ids = $4, copied_at = now() where id = 1",
      [tenantIds, [...new Set([...memberIds, ...orphans.placeholderIds, ...bench.authUserIds, ...prevUsers.filter((u) => !memberIds.includes(u))])], pendingStorage, creatorIds],
    );

    log("checking row counts");
    for (const [table, n0] of summary) {
      const n = n0 - (orphans.droppedBy[table] ?? 0) - (removedBy[table] ?? 0);
      const got = Number((await mir.query(`select count(*) as n from public.${q(table)} where tenant_id = any($1)`, [tenantIds])).rows[0].n);
      if (got !== n) throw new Error(`consistency check failed on ${table}: copied ${n}, mirror has ${got}`);
    }
    for (const [table, col, want] of [["human_members", "id", bench.creators.length], ["human_member_handles", "human_member_id", bench.handles.length], ["creator_packages", "human_member_id", bench.packages.length]]) {
      const got = Number((await mir.query(`select count(*) as n from public.${q(table)} where ${q(col)} = any($1)`, [creatorIds])).rows[0].n);
      if (got !== want) throw new Error(`consistency check failed on ${table}: copied ${want}, mirror has ${got}`);
    }
    checkBudget("before commit; nothing committed");
    await prod.query("commit");
    committing = true;
    await mir.query("commit");
    log("committed: the new copy is live. Removing old logins, then syncing files");
  } catch (e) {
    if (isClientTimeout(e)) {
      mir.connection?.stream?.destroy();
      prod.connection?.stream?.destroy();
      if (committing) {
        throw new Error("the mirror COMMIT timed out, so whether it applied is unknown. Logins were left as they are; run the copy again (it reconciles).");
      }
      cleanupDb = new pg.Client(pgConfig(mirEnv.MIRROR_DB_URL));
      await cleanupDb.connect().catch(() => {});
    } else {
      if (began) await mir.query("rollback").catch(() => {});
      await prod.query("rollback").catch(() => {});
    }
    const stuck = [];
    for (const id of createdUsers) {
      const { error } = await mirApi.auth.admin.deleteUser(id).catch((x) => ({ error: x }));
      if (error && !/not.?found/i.test(error.message ?? "")) stuck.push(id);
    }
    if (stuck.length) {
      await cleanupDb
        .query("update public._zavi_mirror set user_ids = array(select distinct unnest(user_ids || $1::uuid[])) where id = 1", [stuck])
        .catch(() => {});
      console.error(`[mirror] ${stuck.length} login(s) created by this failed run could not be removed now; the next run retries: ${stuck.join(", ")}`);
    }
    throw e;
  }
  await prod.end();

  const stillPending = [];
  const keepUsers = new Set([...memberIds, ...orphans.placeholderIds, ...bench.authUserIds]);
  for (const id of prevUsers) {
    if (keepUsers.has(id)) continue;
    const { error } = await mirApi.auth.admin.deleteUser(id);
    if (error && !/not.?found/i.test(error.message)) stillPending.push(id);
  }
  await mir.query("update public._zavi_mirror set user_ids = $1 where id = 1", [[...keepUsers, ...stillPending]]);

  log("syncing files");
  const files = await syncStorage(prodApi, mirApi, tenantIds, pendingStorage);
  await mir.query("update public._zavi_mirror set pending_storage_tenants = '{}' where id = 1");
  await mir.end();
  await assertDevTokenCarriesTenant(mirEnv, tenantIds);

  log("rows copied:");
  for (const [t, n] of summary.sort((a, b) => b[1] - a[1])) log(`  ${t}: ${n}`);
  log(`members: ${memberIds.length} (sign-in enabled: ${LOGIN_EMAIL}${ravi ? `, ${RAVI_EMAIL}` : ""}; others banned)`);
  log(`connector secrets carried: ${carried.length}; left out: ${leftOut.join(", ") || "none"}`);
  log(`creators: ${bench.creators.length} copied with ${bench.handles.length} handles and ${bench.packages.length} packages (all creator columns; creator-only logins get placeholder emails, sign-in blocked)`);
  if (stillPending.length) log(`users whose removal will be retried next run: ${stillPending.length}`);
  log(`references outside the copy: ${orphans.placeholders} placeholder logins, ${orphans.nulled} set to null, ${orphans.dropped} rows dropped`);
  log(`files: ${files.uploaded} uploaded, ${files.unchanged} unchanged, ${files.removed} removed, ${files.skipped} skipped (${(files.bytes / 1e6).toFixed(1)} MB)`);
  log(`done in ${Math.round((Date.now() - STARTED) / 1000)}s`);
}

async function migrate(mirEnv, ref) {
  execFileSync("supabase", ["db", "push", "--db-url", mirEnv.MIRROR_DB_URL, "--include-all", "--yes"], { cwd: REPO_ROOT, stdio: "inherit" });
  const mir = new pg.Client(pgConfig(mirEnv.MIRROR_DB_URL));
  await mir.connect();
  await mir.query(`create table if not exists public._zavi_mirror (
    id int primary key default 1 check (id = 1),
    project_ref text not null,
    tenant_ids uuid[] not null default '{}',
    user_ids uuid[] not null default '{}',
    pending_storage_tenants uuid[] not null default '{}',
    copied_at timestamptz)`);
  await mir.query("alter table public._zavi_mirror add column if not exists pending_storage_tenants uuid[] not null default '{}'");
  await mir.query("alter table public._zavi_mirror add column if not exists creator_ids uuid[] not null default '{}'");
  await mir.query("alter table public._zavi_mirror enable row level security");
  await mir.query(
    "insert into public._zavi_mirror (id, project_ref) values (1, $1) on conflict (id) do update set project_ref = excluded.project_ref",
    [ref],
  );
  await mir.end();
  log(`migrated, marker written for mirror project ${ref}`);
  await syncAuthHooks({ ref, token: mirEnv.SUPABASE_ACCESS_TOKEN, fetch: timedFetch });
  log("auth hooks match prod: custom access token hook on");
}

async function assertDevTokenCarriesTenant(mirEnv, tenantIds) {
  if (!tenantIds.length) return;
  const res = await timedFetch(`${mirEnv.MIRROR_SUPABASE_URL.replace(/\/$/, "")}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: mirEnv.MIRROR_SERVICE_ROLE_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email: LOGIN_EMAIL, password: mirEnv.DEV_LOGIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`could not sign in to the mirror as ${LOGIN_EMAIL} to check its token: HTTP ${res.status}`);
  const claim = activeTenantClaim((await res.json()).access_token);
  if (!claim || !tenantIds.includes(claim)) {
    throw new Error(`the copy finished, but a mirror sign-in token carries active_tenant_id=${claim ?? "none"}, so company switching and tenant RLS will fail. Run scripts/mirror-upcar.sh migrate with SUPABASE_ACCESS_TOKEN in ~/.zavi/mirror.env to turn on the auth hook`);
  }
  log(`sign-in token carries the active company (${claim}), like prod`);
}

async function findDevUser(api, configuredId) {
  if (configuredId) {
    const { data, error } = await api.auth.admin.getUserById(configuredId);
    if (error || data?.user?.email?.toLowerCase() !== LOGIN_EMAIL) throw new Error(`MIRROR_DEV_USER_ID is not ${LOGIN_EMAIL} in prod`);
    return data.user;
  }
  for (let page = 1; ; page++) {
    const { data, error } = await api.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`prod listUsers failed: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === LOGIN_EMAIL);
    if (hit) {
      log(`tip: add MIRROR_DEV_USER_ID=${hit.id} to ~/.zavi/mirror.env to skip this search`);
      return hit;
    }
    if (data.users.length < 1000) break;
  }
  throw new Error(`${LOGIN_EMAIL} does not exist in prod. Sign it up on www.zaviagent.com and invite it to the companies first.`);
}

async function preflightVault(mir) {
  await mir.query("begin");
  try {
    const { rows } = await mir.query("select vault.create_secret('preflight', $1) as id", [`mirror-preflight-${randomBytes(4).toString("hex")}`]);
    await mir.query("delete from vault.secrets where id = $1", [rows[0].id]);
  } catch (e) {
    throw new Error(`mirror Vault is not writable by this connection: ${e.message}`);
  } finally {
    await mir.query("rollback").catch(() => {});
  }
}

async function insertRows(client, table, cols, rows, upsertKey) {
  if (!rows.length) return;
  const slimAll = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
  let chunk = [];
  let bytes = 2;
  for (const r of slimAll) {
    const b = Buffer.byteLength(JSON.stringify(r)) + 1;
    if (b + 2 > INSERT_MAX_BYTES) throw new Error(`a ${table} row is ${Math.round(b / 1e6)} MB, over the ${INSERT_MAX_BYTES / 1e6} MB insert limit; nothing committed`);
    if (chunk.length && bytes + b > INSERT_MAX_BYTES) {
      await insertChunk(client, table, cols, chunk, upsertKey);
      chunk = [];
      bytes = 2;
    }
    chunk.push(r);
    bytes += b;
  }
  if (chunk.length) await insertChunk(client, table, cols, chunk, upsertKey);
}

async function insertChunk(client, table, cols, slim, upsertKey) {
  const colList = cols.map(q).join(", ");
  const rest = upsertKey ? cols.filter((c) => !upsertKey.includes(c)) : [];
  const onConflict = !upsertKey
    ? ""
    : rest.length
      ? ` on conflict (${upsertKey.map(q).join(", ")}) do update set ${rest.map((c) => `${q(c)} = excluded.${q(c)}`).join(", ")}`
      : ` on conflict (${upsertKey.map(q).join(", ")}) do nothing`;
  await client.query({
    text: `insert into public.${q(table)} (${colList}) overriding system value
     select ${colList} from json_populate_recordset(null::public.${q(table)}, $1::json)${onConflict}`,
    values: [JSON.stringify(slim)],
    query_timeout: 180_000,
  });
}

async function reclaimSpace(mir, tables) {
  await mir.query("set lock_timeout = '5s'");
  let skipped = 0;
  for (const table of tables) {
    const left = BUDGET.maxMinutes * 60_000 - (Date.now() - STARTED);
    checkBudget("while reclaiming space; nothing committed");
    await mir.query(`set statement_timeout = ${Math.max(1000, Math.min(120_000, left))}`);
    try {
      await mir.query(`vacuum full public.${q(table)}`);
    } catch (e) {
      if (e.code !== "55P03" && e.code !== "57014") throw e;
      skipped++;
    }
  }
  await mir.query("reset lock_timeout");
  const size = Number((await mir.query("select pg_database_size(current_database()) as b")).rows[0].b);
  log(`mirror database is ${Math.round(size / 1e6)} MB before the copy${skipped ? ` (${skipped} busy table(s) skipped)` : ""}`);
  return size;
}

async function primaryKey(client, table) {
  const { rows } = await client.query(
    `select a.attname::text as col
       from pg_index i
       cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      where i.indrelid = ('public.' || quote_ident($1))::regclass and i.indisprimary
      order by k.ord`,
    [table],
  );
  if (!rows.length) throw new Error(`${table} keeps its rows across runs but has no primary key to upsert on; nothing committed`);
  return rows.map((r) => r.col);
}

async function foreignKeys(mir, childTables) {
  const { rows } = await mir.query(
    `select c.conname, r.relname as child, tn.nspname as pschema, t.relname as parent, c.confdeltype as rule,
            c.confmatchtype::text as match,
            array_agg(a.attname::text order by k.ord) as cols, array_agg(pa.attname::text order by k.ord) as pcols,
            array_agg(a.attnotnull order by k.ord) as notnull
       from pg_constraint c
       join pg_class r on r.oid = c.conrelid join pg_namespace rn on rn.oid = r.relnamespace
       join pg_class t on t.oid = c.confrelid join pg_namespace tn on tn.oid = t.relnamespace
       cross join lateral unnest(c.conkey, c.confkey) with ordinality as k(ck, pk, ord)
       join pg_attribute a on a.attrelid = r.oid and a.attnum = k.ck
       join pg_attribute pa on pa.attrelid = t.oid and pa.attnum = k.pk
      where c.contype = 'f' and rn.nspname = 'public' and r.relname = any($1)
      group by c.oid, c.conname, r.relname, tn.nspname, t.relname, c.confdeltype, c.confmatchtype`,
    [childTables],
  );
  return rows;
}

function danglingWhere(fk, extra = "") {
  const notNull = fk.cols.map((col) => `c.${q(col)} is not null`).join(" and ");
  const join = fk.cols.map((col, i) => `p.${q(fk.pcols[i])} = c.${q(col)}`).join(" and ");
  return `${extra ? `${extra} and ` : ""}${notNull} and not exists (select 1 from ${q(fk.pschema)}.${q(fk.parent)} p where ${join})`;
}

async function cascadeByHand(mir, mirCols) {
  const noTenant = [...mirCols].filter(([, cols]) => !cols.some((c) => c.column_name === "tenant_id")).map(([t]) => t);
  const fks = (await foreignKeys(mir, noTenant)).filter((fk) => fk.pschema === "public");
  const unsupported = fks.find((fk) => fk.rule === "d");
  if (unsupported) throw new Error(`ON DELETE SET DEFAULT on ${unsupported.child}.${unsupported.conname} is not supported by the mirror wipe; nothing committed`);
  for (let pass = 0; pass < 8; pass++) {
    let changed = 0;
    for (const fk of fks) {
      await budgetStatement(mir, 600_000, "while wiping; nothing committed");
      const fix = fk.rule === "n" ? fkRepair(fk) : { action: "delete" };
      const res = fix.action === "null"
        ? await nullOrDelete(mir, fk.child, fix.cols, danglingWhere(fk), [])
        : await mir.query(`delete from public.${q(fk.child)} c where ${danglingWhere(fk)}`);
      changed += res.rowCount ?? 0;
    }
    if (!changed) return;
  }
  throw new Error("the wipe's cascade did not settle after 8 passes; nothing committed");
}

async function repairOrphans(mir, prodApi, mirApi, tables, tenantIds, createdUsers, memberIds) {
  const stats = { placeholders: 0, placeholderIds: [], nulled: 0, dropped: 0, droppedBy: {} };
  const fks = await foreignKeys(mir, tables);
  const known = new Map();
  for (let pass = 0; pass < 6; pass++) {
    let changed = 0;
    log(`  reference pass ${pass + 1}`);
    for (const fk of fks) {
      await budgetStatement(mir, 600_000, "while checking references; nothing committed");
      const scope = `c.tenant_id = any($1)`;
      if (fk.pschema === "auth" && fk.parent === "users" && fk.cols.length === 1) {
        const { rows } = await mir.query(`select distinct c.${q(fk.cols[0])} as id from public.${q(fk.child)} c where ${danglingWhere(fk, scope)}`, [tenantIds]);
        for (const { id } of rows) {
          if (!known.has(id)) {
            const { data, error } = await prodApi.auth.admin.getUserById(id);
            if (error && !/not.?found|user_not_found/i.test(`${error.code ?? ""} ${error.message ?? ""}`)) {
              throw new Error(`prod user lookup failed for ${id} (${error.message}); nothing committed`);
            }
            known.set(id, data?.user ?? null);
          }
          const u = known.get(id);
          if (!u) continue;
          if (await ensureAuthUser(mirApi, u, randomBytes(24).toString("base64url"), false)) createdUsers.push(id);
          stats.placeholders++;
          changed++;
        }
      }
      const fix = fkRepair(fk);
      let nulled = 0;
      let deleted = 0;
      if (fix.action === "null") ({ nulled, deleted } = await nullOrDelete(mir, fk.child, fix.cols, danglingWhere(fk, scope), [tenantIds]));
      else deleted = (await mir.query(`delete from public.${q(fk.child)} c where ${danglingWhere(fk, scope)}`, [tenantIds])).rowCount ?? 0;
      changed += nulled + deleted;
      stats.nulled += nulled;
      if (deleted) {
        stats.dropped += deleted;
        stats.droppedBy[fk.child] = (stats.droppedBy[fk.child] ?? 0) + deleted;
      }
    }
    if (!changed) {
      const required = new Set();
      for (const fk of fks) {
        if (fk.pschema !== "auth" || fk.parent !== "users" || fk.cols.length !== 1) continue;
        await budgetStatement(mir, 600_000, "while listing placeholder logins; nothing committed");
        const { rows } = await mir.query(`select distinct c.${q(fk.cols[0])} as id from public.${q(fk.child)} c where c.tenant_id = any($1) and c.${q(fk.cols[0])} is not null`, [tenantIds]);
        for (const { id } of rows) if (!memberIds.has(id)) required.add(id);
      }
      stats.placeholderIds = [...required];
      return stats;
    }
  }
  throw new Error("references still dangling after 6 repair passes; nothing committed");
}

async function nullOrDelete(mir, table, cols, where, params) {
  const setNull = cols.map((col) => `${q(col)} = null`).join(", ");
  const RULE_BROKEN = ["23505", "23514", "23502"];
  await mir.query("savepoint null_fk");
  try {
    const res = await mir.query(`update public.${q(table)} c set ${setNull} where ${where}`, params);
    await mir.query("release savepoint null_fk");
    return { nulled: res.rowCount ?? 0, deleted: 0, rowCount: res.rowCount ?? 0 };
  } catch (e) {
    await mir.query("rollback to savepoint null_fk");
    await mir.query("release savepoint null_fk");
    if (!RULE_BROKEN.includes(e.code)) throw e;
  }
  const { rows } = await mir.query(`select c.ctid::text as id from public.${q(table)} c where ${where}`, params);
  let nulled = 0;
  let deleted = 0;
  for (const { id } of rows) {
    await mir.query("savepoint null_fk_row");
    try {
      await mir.query(`update public.${q(table)} c set ${setNull} where c.ctid = $1::tid`, [id]);
      nulled++;
    } catch (e) {
      await mir.query("rollback to savepoint null_fk_row");
      if (!RULE_BROKEN.includes(e.code)) {
        await mir.query("release savepoint null_fk_row");
        throw e;
      }
      await mir.query(`delete from public.${q(table)} c where c.ctid = $1::tid`, [id]);
      deleted++;
    }
    await mir.query("release savepoint null_fk_row");
  }
  return { nulled, deleted, rowCount: nulled + deleted };
}

async function bumpSequences(mir, tables) {
  const { rows } = await mir.query(
    `select c.table_name, c.column_name, pg_get_serial_sequence('public.' || quote_ident(c.table_name), c.column_name) as seq
       from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = any($1)
        and (c.is_identity = 'YES' or c.column_default like 'nextval(%')`,
    [tables],
  );
  for (const r of rows) {
    if (!r.seq) continue;
    await mir.query(
      `select setval($1, greatest((select coalesce(max(${q(r.column_name)}), 0) from public.${q(r.table_name)}), 1))`,
      [r.seq],
    );
  }
}

async function columns(client) {
  const { rows } = await client.query(
    `select c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable, c.is_generated, c.is_identity, c.column_default,
            c.character_maximum_length, c.numeric_precision, c.numeric_scale, c.datetime_precision
       from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      order by c.table_name, c.ordinal_position`,
  );
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.table_name)) m.set(r.table_name, []);
    m.get(r.table_name).push(r);
  }
  return m;
}

async function enums(client) {
  const { rows } = await client.query(
    `select n.nspname || '.' || t.typname as typname, array_agg(e.enumlabel::text order by e.enumsortorder) as labels
       from pg_type t join pg_enum e on e.enumtypid = t.oid
       join pg_namespace n on n.oid = t.typnamespace
      where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_%'
      group by n.nspname, t.typname`,
  );
  return new Map(rows.map((r) => [r.typname, r.labels]));
}

async function ensureAuthUser(api, user, password, enabled) {
  const ban_duration = enabled ? "none" : BANNED;
  const email = user.email || `${user.id}@mirror.invalid`;
  const { data } = await api.auth.admin.getUserById(user.id);
  if (data?.user) {
    if (data.user.email?.toLowerCase() !== email.toLowerCase()) throw new Error(`mirror user ${user.id} has a different email`);
    const { error } = await api.auth.admin.updateUserById(user.id, { password, ban_duration });
    if (error) throw new Error(`mirror user update failed for ${email}: ${error.message}`);
    return false;
  }
  const { error } = await api.auth.admin.createUser({ id: user.id, email, password, email_confirm: true, ban_duration });
  if (error) throw new Error(`mirror createUser failed for ${email}: ${error.message}`);
  return true;
}

async function ensureCreatorLogin(api, login) {
  const { data } = await api.auth.admin.getUserById(login.id);
  if (data?.user) {
    const { error } = await api.auth.admin.updateUserById(login.id, { ban_duration: BANNED });
    if (error) throw new Error(`mirror creator login update failed for ${login.id}: ${error.message}`);
    return false;
  }
  const { error } = await api.auth.admin.createUser({ id: login.id, email: login.email, password: randomBytes(24).toString("base64url"), email_confirm: true, ban_duration: BANNED });
  if (error) throw new Error(`mirror createUser failed for creator login ${login.id}: ${error.message}`);
  return true;
}

async function* walk(api, bucket, prefix, counter) {
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await api.storage.from(bucket).list(prefix, { limit: 1000, offset });
    if (error) throw new Error(`storage list ${bucket}/${prefix} failed: ${error.message}`);
    if (!data?.length) return;
    for (const item of data) {
      const p = `${prefix}/${item.name}`;
      if (item.id == null) {
        yield* walk(api, bucket, p, counter);
        continue;
      }
      if (++counter.seen > BUDGET.maxFiles * 3) throw new Error(`storage listing exceeded ${BUDGET.maxFiles * 3} objects; rows are committed, files partly synced (retried next run)`);
      checkBudget("while syncing files; rows are committed, files partly synced (retried next run)");
      const etag = item.metadata?.eTag ?? null;
      const size = Number.isFinite(item.metadata?.size) ? item.metadata.size : null;
      yield { path: p, tag: etag && size != null ? `${etag}:${size}` : null, size };
    }
    if (data.length < 1000) return;
  }
}

async function syncStorage(prodApi, mirApi, tenantIds, removedTenants) {
  const stats = { uploaded: 0, unchanged: 0, removed: 0, skipped: 0, bytes: 0 };
  const counter = { seen: 0, source: 0 };
  const { data: pBuckets, error } = await prodApi.storage.listBuckets();
  if (error) throw new Error(`prod storage listBuckets failed: ${error.message}`);
  const { data: mBuckets, error: mErr } = await mirApi.storage.listBuckets();
  if (mErr) throw new Error(`mirror storage listBuckets failed: ${mErr.message}`);
  const prodBuckets = new Map(pBuckets.map((b) => [b.name, b]));
  const mirBuckets = new Set(mBuckets.map((b) => b.name));
  for (const name of new Set([...prodBuckets.keys(), ...mirBuckets])) {
    const pb = prodBuckets.get(name);
    if (pb && !mirBuckets.has(name)) {
      const { error: cErr } = await mirApi.storage.createBucket(name, { public: pb.public });
      if (cErr && !/exists/i.test(cErr.message)) throw new Error(`mirror createBucket ${name} failed: ${cErr.message}`);
    }
    for (const tid of [...tenantIds, ...removedTenants]) {
      const src = new Map();
      if (pb && tenantIds.includes(tid)) for await (const f of walk(prodApi, name, tid, counter)) src.set(f.path, f);
      const dst = new Map();
      if (mirBuckets.has(name) || pb) for await (const f of walk(mirApi, name, tid, counter)) dst.set(f.path, f);
      const gone = [...dst.keys()].filter((p) => !src.has(p));
      for (let i = 0; i < gone.length; i += 100) {
        const batch = gone.slice(i, i + 100);
        const { error: rErr } = await mirApi.storage.from(name).remove(batch);
        if (rErr) throw new Error(`mirror storage remove failed in ${name}: ${rErr.message}`);
        stats.removed += batch.length;
      }
      for (const [path, f] of src) {
        checkBudget("while syncing files; rows are committed, files partly synced (retried next run)");
        if (++counter.source > BUDGET.maxFiles) throw new Error(`more than ${BUDGET.maxFiles} source files; rows are committed, files partly synced (retried next run)`);
        if (f.tag && dst.get(path)?.tag === f.tag) {
          stats.unchanged++;
          continue;
        }
        if (f.size == null || f.size > 50e6 || stats.bytes + f.size > BUDGET.maxStorageBytes) {
          if (dst.has(path)) {
            const { error: rErr } = await mirApi.storage.from(name).remove([path]);
            if (rErr) throw new Error(`mirror storage remove failed for ${name}/${path}: ${rErr.message}`);
            stats.removed++;
          }
          stats.skipped++;
          continue;
        }
        const { data: blob, error: dErr } = await prodApi.storage.from(name).download(path);
        if (dErr || !blob) throw new Error(`prod storage download failed for ${name}/${path}: ${dErr?.message ?? "empty"}`);
        const { error: uErr } = await mirApi.storage.from(name).upload(path, blob, { upsert: true, contentType: blob.type || undefined });
        if (uErr) throw new Error(`mirror storage upload failed for ${name}/${path}: ${uErr.message}`);
        stats.uploaded++;
        stats.bytes += blob.size;
        if (stats.uploaded % 50 === 0) log(`  files uploaded: ${stats.uploaded} (${Math.round(stats.bytes / 1e6)} MB)`);
      }
    }
  }
  return stats;
}

main().catch((e) => {
  console.error("[mirror] FAILED:", e.message);
  process.exit(1);
});
