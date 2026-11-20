
import {
  deriveStarterReserved,
  splitSqlStatements,
  starterSql,
  type StarterReserved,
} from "./site-sql-policy";

type GrantRole = "anon" | "authenticated";
const ROLES: GrantRole[] = ["anon", "authenticated"];

export type StarterFunction = { name: string; body: string; security_definer: boolean; config: string[] };

export type StarterBaseline = {
  reserved: StarterReserved;
  functions: StarterFunction[];
  table_grants: Record<string, Partial<Record<GrantRole, string[]>>>;
  function_grants: Record<string, GrantRole[]>;
  policies: Record<string, string[]>;
  triggers: Record<string, { table: string; fn: string }>;
};

const SAFE_NAME = /^[a-z_][a-z0-9_]*$/;
const BODY_TAG = "$zavi_starter_body$";
const TABLE_PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const COLUMN_PRIVS = new Set(["SELECT", "INSERT", "UPDATE", "REFERENCES"]);

const bare = (q: string) => q.trim().split(".").pop()!.replace(/^"(.*)"$/, "$1").toLowerCase();

function safe(name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`starter object name is not a plain identifier: ${name}`);
  return name;
}

export function deriveStarterBaseline(sql: string): StarterBaseline {
  const reserved = deriveStarterReserved(sql);
  const split = splitSqlStatements(sql);
  if ("error" in split) throw new Error(`starter SQL is unreadable: ${split.error}`);
  const b: StarterBaseline = { reserved, functions: [], table_grants: {}, function_grants: {}, policies: {}, triggers: {} };
  for (const st of split) {
    const t = st.text.toLowerCase();
    const fn = /^create (?:or replace )?function ([a-z0-9_."]+)\s*\(/.exec(t);
    if (fn) {
      if (st.bodies.length !== 1) throw new Error("a starter function must have exactly one $$ body");
      const config: string[] = [];
      let lit = 0;
      const header = t.replace(/\$body\d+\$/g, " ");
      for (const s of header.matchAll(/\bset ([a-z_]+) (?:=|to) ('_'|[a-z_]+)/g)) {
        const v = s[2] === "'_'" ? st.literals[lit++] ?? "" : s[2];
        config.push(`${s[1]}=${v === "" ? '""' : v}`);
      }
      if (st.bodies[0].includes(BODY_TAG)) throw new Error("starter body contains the check's quote tag");
      b.functions.push({ name: safe(bare(fn[1])), body: st.bodies[0], security_definer: /\bsecurity definer\b/.test(t), config });
      continue;
    }
    const grant = /^grant (.+?) on (?:table )?(?!function )([a-z0-9_."]+) to (.+)$/.exec(t);
    if (grant && reserved.tables.has(bare(grant[2]))) {
      const table = bare(grant[2]);
      const privs = grant[1].split(/\s*,\s*/).map((p) => p.trim().toUpperCase());
      for (const role of grant[3].split(/\s*,\s*/).map((r) => r.trim()) as GrantRole[]) {
        if (!ROLES.includes(role)) continue;
        const cur = (b.table_grants[table] ??= {});
        cur[role] = [...new Set([...(cur[role] ?? []), ...(privs.includes("ALL") ? TABLE_PRIVS : privs)])];
      }
      continue;
    }
    const fgrant = /^grant execute on function ([a-z0-9_."]+)\s*\([^)]*\) to (.+)$/.exec(t);
    if (fgrant && reserved.functions.has(bare(fgrant[1]))) {
      const f = bare(fgrant[1]);
      for (const role of fgrant[2].split(/\s*,\s*/).map((r) => r.trim()) as GrantRole[]) {
        if (ROLES.includes(role)) b.function_grants[f] = [...new Set([...(b.function_grants[f] ?? []), role])];
      }
      continue;
    }
    const pol = /^create policy ([a-z0-9_"]+) on ([a-z0-9_."]+)/.exec(t);
    if (pol && reserved.tables.has(bare(pol[2]))) {
      (b.policies[bare(pol[2])] ??= []).push(safe(bare(pol[1])));
      continue;
    }
    const trg = /^create (?:or replace )?trigger ([a-z0-9_"]+) .*? on ([a-z0-9_."]+) .*?execute (?:function|procedure) ([a-z0-9_."]+)\s*\(/.exec(t);
    if (trg) {
      const table = trg[2].includes(".") ? trg[2] : `public.${trg[2]}`;
      if (!/^[a-z_]+\.[a-z_]+$/.test(table)) throw new Error(`starter trigger table is not plain: ${table}`);
      b.triggers[safe(bare(trg[1]))] = { table, fn: safe(bare(trg[3])) };
    }
  }
  for (const f of reserved.functions) b.function_grants[f] ??= [];
  return b;
}

let baselineCache: StarterBaseline | null = null;
export function starterBaseline(): StarterBaseline {
  baselineCache ??= deriveStarterBaseline(starterSql());
  return baselineCache;
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const NOT_EXTENSION = (classTable: string, oid: string) =>
  `not exists (select 1 from pg_catalog.pg_depend d where d.classid = '${classTable}'::pg_catalog.regclass and d.objid = ${oid} and d.deptype = 'e')`;
const PUBLIC_CLASS = `pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace`;
const PUBLIC_PROC = `pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace`;
const PLATFORM_NSP = `('pg_catalog','information_schema','auth','storage','extensions','vault','realtime','graphql','graphql_public','net','cron','pgsodium','pgsodium_masks','pgbouncer','supabase_functions','supabase_migrations','_realtime','_analytics','pgmq','pgtle','topology','tiger','tiger_data')`;

export function siteCatalogCheckSql(b: StarterBaseline = starterBaseline()): string {
  const parts: string[] = [];
  const reservedFns = [...b.reserved.functions].map(safe);
  const reservedTables = [...b.reserved.tables].map(safe);

  parts.push(`select 'table without row level security: public.' || c.relname from ${PUBLIC_CLASS}
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity and ${NOT_EXTENSION("pg_catalog.pg_class", "c.oid")}`);
  parts.push(`select 'materialized view (bypasses row level security): public.' || c.relname from ${PUBLIC_CLASS}
    where n.nspname = 'public' and c.relkind = 'm' and ${NOT_EXTENSION("pg_catalog.pg_class", "c.oid")}`);
  parts.push(`select 'view without security_invoker: public.' || c.relname from ${PUBLIC_CLASS}
    where n.nspname = 'public' and c.relkind = 'v' and ${NOT_EXTENSION("pg_catalog.pg_class", "c.oid")}
      and not coalesce(pg_catalog.array_to_string(c.reloptions, ',') ~* '(^|,)security_invoker=(true|on|1|yes)(,|$)', false)`);
  if (reservedTables.length > 0) {
    parts.push(`select 'view that reads a starter table: public.' || r.view_name from (
      with recursive deps(view_name, dep_schema, dep_name) as (
        select u.view_name::text, u.table_schema::text, u.table_name::text
          from information_schema.view_table_usage u where u.view_schema = 'public'
        union
        select d.view_name, u.table_schema::text, u.table_name::text
          from deps d join information_schema.view_table_usage u
            on u.view_schema = d.dep_schema and u.view_name = d.dep_name
      )
      select distinct view_name from deps
        where dep_schema = 'public' and dep_name in (${reservedTables.map(q).join(", ")})
    ) r`);
  }
  parts.push(`select 'SECURITY DEFINER function without a pinned search_path: ' || n.nspname || '.' || p.proname from ${PUBLIC_PROC}
    where p.prosecdef and n.nspname not in ${PLATFORM_NSP}
      and (n.nspname = 'public' or n.nspowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user))
      and ${NOT_EXTENSION("pg_catalog.pg_proc", "p.oid")}
      and not exists (select 1 from pg_catalog.unnest(coalesce(p.proconfig, '{}'::text[])) cfg where cfg like 'search_path=%')`);
  parts.push(`select 'SECURITY DEFINER function the starter does not define: public.' || p.proname from ${PUBLIC_PROC}
    where p.prosecdef and n.nspname = 'public' and p.proname not in (${reservedFns.map(q).join(", ")})
      and ${NOT_EXTENSION("pg_catalog.pg_proc", "p.oid")}`);

  for (const f of b.functions) {
    const cfg = f.config.length ? `array[${f.config.map(q).join(", ")}]::text[]` : `'{}'::text[]`;
    parts.push(`select 'starter function changed or overloaded: public.${f.name}' where
      (select count(*) from ${PUBLIC_PROC} where n.nspname = 'public' and p.proname = ${q(f.name)}) <> 1
      or not exists (select 1 from ${PUBLIC_PROC} where n.nspname = 'public' and p.proname = ${q(f.name)}
        and p.prosrc = ${BODY_TAG}${f.body}${BODY_TAG} and p.prosecdef = ${f.security_definer}
        and coalesce(p.proconfig, '{}'::text[]) = ${cfg})`);
    for (const role of ROLES) {
      if ((b.function_grants[f.name] ?? []).includes(role)) continue;
      parts.push(`select '${role} can execute public.${f.name}' from ${PUBLIC_PROC}
        where n.nspname = 'public' and p.proname = ${q(f.name)} and pg_catalog.has_function_privilege('${role}', p.oid, 'EXECUTE')`);
    }
  }

  for (const [name, t] of Object.entries(b.triggers)) {
    const [schema, table] = t.table.split(".");
    parts.push(`select 'starter trigger missing or changed: ${name}' where not exists (
      select 1 from pg_catalog.pg_trigger tg join pg_catalog.pg_class c on c.oid = tg.tgrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_proc p on p.oid = tg.tgfoid join pg_catalog.pg_namespace pn on pn.oid = p.pronamespace
      where tg.tgname = ${q(name)} and n.nspname = ${q(schema)} and c.relname = ${q(table)}
        and pn.nspname = 'public' and p.proname = ${q(t.fn)} and tg.tgenabled <> 'D')`);
  }

  for (const table of reservedTables) {
    const reg = q(`public.${table}`);
    parts.push(`select 'starter table missing: public.${table}' where pg_catalog.to_regclass(${reg}) is null`);
    for (const role of ROLES) {
      const allowed = new Set(b.table_grants[table]?.[role] ?? []);
      for (const priv of TABLE_PRIVS) {
        if (allowed.has(priv)) continue;
        const fn = COLUMN_PRIVS.has(priv) ? "has_any_column_privilege" : "has_table_privilege";
        parts.push(`select '${role} has ${priv} on public.${table}' where pg_catalog.to_regclass(${reg}) is not null
          and pg_catalog.${fn}('${role}', ${reg}, '${priv}')`);
      }
    }
    const policies = (b.policies[table] ?? []).map(q);
    parts.push(`select 'policy the starter does not define on public.${table}: ' || pol.polname
      from pg_catalog.pg_policy pol where pg_catalog.to_regclass(${reg}) is not null and pol.polrelid = pg_catalog.to_regclass(${reg})
        ${policies.length ? `and pol.polname not in (${policies.join(", ")})` : ""}`);
  }

  const apiRoles = ROLES.map(q).join(", ");
  parts.push(`select 'grant option for ' || r.rolname || ' on public.' || c.relname
    from ${PUBLIC_CLASS} cross join lateral pg_catalog.aclexplode(c.relacl) a join pg_catalog.pg_roles r on r.oid = a.grantee
    where n.nspname = 'public' and r.rolname in (${apiRoles}) and a.is_grantable`);
  parts.push(`select 'grant option for ' || r.rolname || ' on function public.' || p.proname
    from ${PUBLIC_PROC} cross join lateral pg_catalog.aclexplode(p.proacl) a join pg_catalog.pg_roles r on r.oid = a.grantee
    where n.nspname = 'public' and r.rolname in (${apiRoles}) and a.is_grantable`);
  for (const role of ROLES) {
    parts.push(`select '${role} can use the platform schema zavi' where pg_catalog.to_regnamespace('zavi') is not null
      and pg_catalog.has_schema_privilege('${role}', 'zavi', 'USAGE')`);
  }

  return `select problem from (\n${parts.map((p) => `  ${p.trim()}`).join("\n  union all\n")}\n) as zavi_catalog_check(problem)`;
}

export const ROLE_FINGERPRINT_SQL = `select coalesce((select pg_catalog.string_agg(r.rolname || ':' || r.rolsuper || r.rolinherit || r.rolcreaterole || r.rolcreatedb || r.rolcanlogin || r.rolreplication || r.rolbypassrls, ',' order by r.rolname) from pg_catalog.pg_roles r), '')
  || '|' || coalesce((select pg_catalog.string_agg(m.roleid::text || '>' || m.member::text, ',' order by m.roleid, m.member) from pg_catalog.pg_auth_members m), '')
  || '|' || coalesce((select pg_catalog.string_agg(s.setdatabase::text || '/' || s.setrole::text || '=' || pg_catalog.array_to_string(s.setconfig, ';'), ',' order by s.setdatabase, s.setrole) from pg_catalog.pg_db_role_setting s), '') as f`;

export function catalogAssertionSql(rolesBefore: string, nonce: string, b: StarterBaseline = starterBaseline()): string {
  if (!/^[a-z0-9]{8,64}$/.test(nonce)) throw new Error("catalog assertion nonce must be lowercase alphanumeric");
  const tag = `$zavi_check_${nonce}$`;
  const rolesTag = `$zavi_roles_${nonce}$`;
  if (rolesBefore.includes(rolesTag)) throw new Error("role fingerprint contains the quote tag");
  const rolesNow = ROLE_FINGERPRINT_SQL.replace(/ as f$/, "");
  return `do ${tag}
declare v text;
begin
  select pg_catalog.string_agg(problem, '; ') into v from (${siteCatalogCheckSql(b)}) as zavi_problems;
  if (${rolesNow}) is distinct from ${rolesTag}${rolesBefore}${rolesTag} then
    v := pg_catalog.concat_ws('; ', v, 'database roles, role memberships or role settings changed');
  end if;
  if v is not null then
    raise exception 'zavi catalog check failed: %', v;
  end if;
end ${tag};`;
}

export function catalogProblems(rows: unknown[]): string[] {
  return (rows ?? [])
    .map((r) => (r && typeof r === "object" ? (r as { problem?: unknown }).problem : null))
    .filter((p): p is string => typeof p === "string" && p.length > 0);
}
