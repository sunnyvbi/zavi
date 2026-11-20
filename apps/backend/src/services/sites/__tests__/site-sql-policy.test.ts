import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkSiteMigrationSql, splitSqlStatements } from "../site-sql-policy";

const ok = (sql: string) => expect(checkSiteMigrationSql(sql)).toEqual({ ok: true });
const refused = (sql: string, why?: RegExp) => {
  const r = checkSiteMigrationSql(sql);
  expect(r.ok).toBe(false);
  if (why && !r.ok) expect(r.reason).toMatch(why);
};

const BOOKINGS = `
-- Grooming bookings
create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price_cents int not null check (price_cents >= 0),
  active boolean not null default true,
  sort_order int not null default 0
);
alter table public.services enable row level security;
drop policy if exists services_read on public.services;
create policy services_read on public.services for select to anon, authenticated using (active);
create policy services_admin on public.services for all to authenticated using (public.is_admin()) with check (public.is_admin());

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id),
  customer_name text not null,
  customer_email text not null,
  starts_at timestamptz not null,
  notes text default 'none; really',
  created_at timestamptz not null default now()
);
create index if not exists bookings_starts_at_idx on public.bookings (starts_at);
alter table public.bookings enable row level security;
create policy bookings_insert on public.bookings for insert to anon, authenticated with check (true);
create policy bookings_admin on public.bookings for select to authenticated using (public.is_admin());
grant select on public.services to anon, authenticated;
grant insert on public.bookings to anon, authenticated;

create or replace function public.booked_slots(day date)
returns setof timestamptz
language sql
stable
as $$
  select b.starts_at from public.bookings b where b.starts_at::date = day;
$$;
revoke all on function public.booked_slots(date) from public;
grant execute on function public.booked_slots(date) to anon, authenticated;

insert into public.services (name, price_cents, sort_order) values ('Bath & brush', 4500, 1), ('Full groom', 8500, 2)
on conflict do nothing;
comment on table public.bookings is 'Customer bookings';
`;

describe("site migration SQL policy — allowed", () => {
  it("a realistic booking schema passes", () => ok(BOOKINGS));

  it("the platform's own starter would be refused (it is applied without this policy)", () => {
    const starter = readFileSync(
      join(__dirname, "../../provisioning/templates/vite-react-supabase/files/supabase/starter.sql"),
      "utf-8",
    );
    refused(starter, /starter|SECURITY DEFINER/);
  });

  it("additive alter table actions, enums, sequences, triggers, views, extensions", () => {
    ok(`alter table public.bookings add column if not exists phone text, add constraint phone_len check (char_length(phone) < 40);`);
    ok(`alter table bookings alter column notes set default '', alter column phone drop default;`);
    ok(`create type public.booking_status as enum ('new', 'done');`);
    ok(`create sequence if not exists public.ticket_seq;`);
    ok(`create or replace view public.upcoming with (security_invoker = true) as select * from public.bookings where starts_at > now();`);
    ok(`create extension if not exists pgcrypto;`);
    ok(`create extension if not exists "uuid-ossp" with schema extensions;`);
    ok(`create or replace function public.touch() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
        drop trigger if exists touch_bookings on public.bookings;
        create trigger touch_bookings before update on public.bookings for each row execute function public.touch();`);
    ok(`grant usage on schema public to anon, authenticated; grant select on all tables in schema public to authenticated;`);
  });

  it("keywords inside literals, comments and bodies never count as statements", () => {
    ok(`insert into public.notes (body) values ('drop table x; truncate y; grant all to postgres');`);
    ok(`/* drop table public.x; */ create table if not exists public.a (id int); -- truncate public.a;
        alter table public.a enable row level security;`);
    ok(`insert into public.notes (body) values (E'it\\'s; drop table x');`);
  });
});

describe("site migration SQL policy — refused", () => {
  it("destructive statements", () => {
    refused(`drop table public.bookings;`, /DROP/);
    refused(`drop table if exists public.bookings cascade;`, /DROP/);
    refused(`truncate public.bookings;`, /TRUNCATE/);
    refused(`delete from public.bookings;`, /rows that already exist/);
    refused(`update public.bookings set notes = '';`, /rows that already exist/);
    refused(`alter table public.bookings drop column notes;`, /drops a column/);
    refused(`alter table public.bookings rename to old_bookings;`, /renames/);
    refused(`alter table public.bookings alter column starts_at type date;`);
  });

  it("a DEFERRABLE INITIALLY DEFERRED constraint trigger (it would run at commit); an immediate one stays allowed", () => {
    const fn = `create or replace function public.chk() returns trigger language plpgsql as $$ begin return null; end $$;`;
    refused(`${fn} create constraint trigger chk_late after insert on public.bookings deferrable initially deferred for each row execute function public.chk();`, /INITIALLY DEFERRED/);
    ok(`${fn} create constraint trigger chk_now after insert on public.bookings for each row execute function public.chk();`);
  });

  it("anything outside public: auth, storage, extensions", () => {
    refused(`alter table auth.users add column x int;`, /outside the public schema/);
    refused(`create table storage.objects2 (id int);`, /outside the public schema/);
    refused(`create policy p on storage.objects for select using (true);`, /outside the public schema/);
    refused(`insert into auth.users (id) values (gen_random_uuid());`, /outside the public schema/);
    refused(`create or replace function extensions.f() returns int language sql as $$ select 1 $$;`, /outside the public schema/);
    refused(`grant select on auth.users to anon;`, /outside the public schema/);
    refused(`grant usage on schema auth to anon;`, /schema other than public/);
  });

  it("turning row level security off", () => {
    refused(`alter table public.bookings disable row level security;`, /row level security off/);
    refused(`alter table public.bookings no force row level security;`, /row level security off/);
  });

  it("grants to powerful roles, role changes, session switches", () => {
    refused(`grant all on public.bookings to service_role;`, /only anon and authenticated/);
    refused(`grant select on public.bookings to postgres;`, /only anon and authenticated/);
    refused(`grant postgres to authenticated;`, /GRANT of a role/);
    refused(`grant select on public.bookings to authenticated with grant option;`, /GRANT OPTION/);
    refused(`create role hacker login;`, /role change/);
    refused(`alter role authenticated set search_path = auth;`, /role change/);
    refused(`set role postgres;`, /SET/);
    refused(`alter default privileges in schema public grant all on tables to anon;`, /DEFAULT PRIVILEGES/);
  });

  it("SECURITY DEFINER functions are refused, and only sql / plpgsql bodies", () => {
    refused(`create function public.f() returns int language sql security definer as $$ select 1 $$;`, /SECURITY DEFINER/);
    refused(`create function public.f() returns void language plpgsql security definer set search_path = '' as $$ begin execute 'drop table public.x'; end $$;`, /SECURITY DEFINER/);
    refused(`create function public.f() returns int language c as 'x', 'y';`, /language c/);
  });

  it("DO blocks, transactions, COPY, queries, unknown statements", () => {
    refused(`do $$ begin create type public.s as enum ('a'); exception when duplicate_object then null; end $$;`, /DO block/);
    refused(`begin; create table public.a (id int); commit;`, /transaction/);
    refused(`copy public.a from '/etc/passwd';`, /COPY/);
    refused(`select pg_terminate_backend(1);`, /query|server-admin/);
    refused(`vacuum full;`);
    refused(`create index concurrently i on public.a (id);`, /CONCURRENTLY/);
    refused(`create extension if not exists dblink;`, /extension dblink/);
  });

  it("malformed SQL fails closed", () => {
    refused(`insert into public.a values ('unterminated);`, /unterminated string/);
    refused(`create function public.f() returns int language sql as $$ select 1;`, /unterminated \$\$/);
    refused(`/* never closed`, /unterminated/);
  });
});

describe("splitSqlStatements", () => {
  it("splits on top-level semicolons only and keeps $$ bodies aside", () => {
    const r = splitSqlStatements(`create function public.f() returns int language sql as $fn$ select 1; select 2; $fn$; select 3;`);
    expect(Array.isArray(r)).toBe(true);
    const st = r as Array<{ text: string; bodies: string[] }>;
    expect(st).toHaveLength(2);
    expect(st[0].bodies[0]).toContain("select 2;");
  });
});

describe("site migration SQL policy — superuser execution and data exposure", () => {
  it("F1: any function body is checked, not only SECURITY DEFINER ones", () => {
    refused(`create function public.pwn() returns int language plpgsql as $$ begin delete from auth.users; return 1; end $$;`, /auth|system schema/);
    refused(`create function public.f() returns void language plpgsql as $$ begin execute 'select 1'; end $$;`, /dynamic SQL/);
    refused(`create function public.f() returns int language sql as 'select 1';`, /\$\$ body/);
  });

  it("F2: SECURITY DEFINER is refused in site migrations", () => {
    refused(`create function public.f(p uuid) returns void language plpgsql security definer set search_path = auth as $$ begin delete from users where id = p; end $$;`, /SECURITY DEFINER/);
    refused(`create function public.g() returns int language sql security definer set search_path = '' as $$ select 1 $$;`, /SECURITY DEFINER/);
    refused(`alter function public.g() security definer;`);
  });

  it("F3: block comments cannot hide a platform-schema reference", () => {
    refused(`create function public.f() returns void language plpgsql as $$ begin delete from auth/**/.users; end $$;`, /auth|system schema/);
    refused(`create function public.f() returns void language plpgsql as $$ begin delete from auth /* x */ . users; end $$;`, /auth|system schema/);
    refused(`create function public.f() returns int language plpgsql as $$ begin return (select count(*) from auth/**/.users); end $$;`, /auth/);
  });

  it("F4: no CTAS, no materialized views, views only security_invoker, nothing reads auth/storage", () => {
    refused(`create table public.leaked as select email from auth.users;`, /CREATE TABLE AS/);
    refused(`create materialized view public.m as select 1;`, /materialized/);
    refused(`create view public.v as select * from public.bookings;`, /security_invoker/);
    ok(`create view public.v with (security_invoker = true) as select id from public.bookings;`);
    refused(`create view public.v with (security_invoker = true) as select email from auth.users;`, /auth/);
    refused(`insert into public.leak (email) select email from auth.users;`, /auth/);
    refused(`create policy p on public.a for select using (exists (select 1 from storage.objects));`, /storage/);
  });

  it("F4: auth.uid()/jwt() in policies and FKs to auth.users stay allowed", () => {
    ok(`create table if not exists public.notes (id uuid primary key, user_id uuid references auth.users (id) on delete cascade, body text);
        create policy notes_own on public.notes for all to authenticated using (user_id = (select auth.uid())) with check (user_id = auth.uid());
        create policy notes_role on public.notes for select using (auth.jwt() ->> 'role' = 'x');
        alter table public.notes enable row level security;`);
    ok(`create table if not exists public.t (id uuid primary key default extensions.uuid_generate_v4()); alter table public.t enable row level security;`);
  });

  it("F5: a top-level UPDATE / DELETE never runs on the live database, whatever its WHERE", () => {
    refused(`update public.members set role = 'admin' from (select 1 where true) marker;`, /rows that already exist/);
    refused(`delete from public.a using (select 1 where true) x;`, /rows that already exist/);
    refused(`update public.members m set note = 'x' from (select 1 as one) s where m.id = 1;`, /rows that already exist/);
  });
});

describe("site migration SQL policy — admin functions anywhere", () => {
  it("refuses them in top-level statements and bodies", () => {
    refused(`insert into public.a (t) select pg_read_file('/etc/passwd');`, /server-admin/);
    refused(`create table if not exists public.b (t text default pg_read_file('x'));`, /server-admin/);
    refused(`create function public.f() returns void language plpgsql as $$ begin perform set_config('role', 'postgres', true); end $$;`, /server-admin/);
  });
});

describe("site migration SQL policy — round 3", () => {
  it("F1: quoted or mixed-case names cannot dodge the server-admin denylist", () => {
    refused(`insert into public.a (t) select "pg_read_file"('/etc/passwd');`, /server-admin|system/);
    refused(`insert into public.a (t) select "set_config"('role', 'postgres', true);`, /server-admin/);
    refused(`create function public.f() returns void language plpgsql as $$ begin perform "dblink_exec"('x', 'y'); end $$;`, /server-admin/);
    refused(`create function public.f() returns int language sql as $$ select count(*) from "auth"."users" $$;`, /auth/);
    refused(`insert into public.a (t) select U&"\\0070g_read_file"('x');`, /U&/);
    refused(`insert into public.a (t) values (current_setting('app.settings.jwt_secret'));`, /server-admin/);
  });

  it("F1: unqualified system catalogs are off limits too", () => {
    refused(`insert into public.a (t) select rolname from pg_roles;`, /system catalog/);
    refused(`create function public.f() returns int language sql as $$ select count(*)::int from pg_class $$;`, /system catalog/);
    ok(`create extension if not exists pg_trgm;`);
  });

  it("F2: SQL hidden in a string literal cannot run", () => {
    refused(`insert into public.a (x) select query_to_xml('select * from auth.users', true, false, '');`, /executes SQL from a string|server-admin/);
    refused(`insert into public.a (x) select table_to_xml('auth.users', true, false, '');`, /executes SQL from a string|auth/);
    refused(`insert into public.a (x) select cursor_to_xml('c', 1, true, false, '');`, /executes SQL from a string/);
    refused(`insert into public.a (x) select query_to_xml_and_xmlschema('select 1', true, false, '');`, /executes SQL from a string/);
    refused(`insert into public.a (x) select ts_stat('select vec from auth.x');`, /executes SQL from a string/);
    refused(`create function public.f() returns xml language sql as $$ select query_to_xml('select 1', true, false, '') $$;`, /executes SQL from a string/);
    refused(`insert into public.a (n) select nextval('auth.refresh_tokens_id_seq');`, /auth|calls nextval/);
    refused(`insert into public.a (n) values ($q$auth.users$q$::regclass);`, /auth|object-id/);
    refused(`insert into public.a (n) values (('au' || 'th.users')::regclass);`, /object-id/);
    refused(`insert into public.a (n) values (to_regclass('public.a'));`, /object-id/);
  });

  it("F2: an ordinary string that merely mentions a domain is fine", () => {
    ok(`insert into public.contacts (email) values ('owner@storage.example.com'), ('https://auth.example.com/x');`);
  });

  it("F3: the starter's functions and trigger cannot be replaced or shadowed", () => {
    refused(`create or replace function public.is_admin() returns boolean language sql as $$ select true $$;`, /starter/);
    refused(`create or replace function is_admin() returns boolean language sql as $$ select true $$;`, /starter/);
    refused(`create function public."IS_ADMIN"(x int) returns boolean language sql as $$ select true $$;`, /starter/);
    refused(`create or replace function public.handle_new_user() returns trigger language plpgsql as $$ begin return new; end $$;`, /starter/);
    refused(`create trigger t after insert on public.notes for each row execute function public.handle_new_user();`, /starter/);
  });

  it("F4: every table created in the file must enable row level security in the same file", () => {
    refused(`create table if not exists public.secrets (id int primary key, v text);`, /row level security/);
    refused(`create table public.a (id int); create table public.b (id int); alter table public.a enable row level security;`, /public\.b/);
    ok(`create table public."Mixed" (id int); alter table public.mixed enable row level security;`.replace('"Mixed"', "mixed"));
    refused(`create temp table t (id int);`, /temporary/);
  });

  it("F5: the starter's tables cannot be written, granted, altered or given policies", () => {
    refused(`update public.profiles set role = 'admin' where email = 'me@x.com';`, /starter/);
    refused(`update profiles set role = 'admin' where id = '00000000-0000-0000-0000-000000000000';`, /starter/);
    refused(`insert into public.profiles (id, role) values ('00000000-0000-0000-0000-000000000000', 'admin');`, /starter/);
    refused(`delete from public."profiles" where id = '00000000-0000-0000-0000-000000000000';`, /starter/);
    refused(`grant update on public.profiles to authenticated;`, /starter/);
    refused(`grant execute on function public.is_admin() to anon;`, /starter/);
    refused(`create policy p on public.profiles for update to authenticated using (true);`, /starter/);
    refused(`alter table public.profiles add column note text;`, /starter/);
    refused(`create trigger t before insert on public.profiles for each row execute function public.touch();`, /starter/);
    refused(`create function public.f() returns trigger language plpgsql as $$ begin update public.profiles set role = 'admin' where id = new.owner; return new; end $$;`, /starter/);
    refused(`create function public.f() returns void language plpgsql as $$ begin set role postgres; end $$;`, /switches role/);
    refused(`create function public.f() returns setof text language sql set search_path = auth as $$ select email from users $$;`, /sets search_path/);
    ok(`create function public.g() returns trigger language plpgsql as $$ begin update public.members set role = 'x' where id = new.id; return new; end $$;`);
    refused(`grant all on all functions in schema public to anon;`, /schema-wide/);
    refused(`grant insert on all tables in schema public to authenticated;`, /schema-wide/);
    ok(`grant select on all tables in schema public to authenticated;`);
    ok(`create table if not exists public.notes (id uuid primary key, owner uuid references public.profiles (id)); alter table public.notes enable row level security;`);
  });

  it("F7: every top-level UPDATE / DELETE / upsert-update is refused; plain inserts (and do nothing) pass", () => {
    for (const sql of [
      `delete from public.services where id = '00000000-0000-0000-0000-000000000000';`,
      `delete from public.sessions where expires_at < now() - interval '30 days';`,
      `update public.services set active = false where sort_order in (1, 2, 3) returning id;`,
      `update public.services set "where" = 1;`,
      `insert into public.services (id, name) values (1, 'a') on conflict (id) do update set name = excluded.name;`,
    ]) {
      refused(sql, /rows that already exist/);
    }
    ok(`insert into public.services (id, name) values (1, 'a');`);
    ok(`insert into public.services (id, name) values (1, 'a') on conflict (id) do nothing;`);
    refused(`insert into public.services (id, name) values (1, public.mutator());`, /calls public\.mutator\(\)/);
    refused(`insert into public.services (id, name) values (1, mutator());`, /calls mutator\(\)/);
    ok(`insert into public.services (id, name, created_at) values (gen_random_uuid(), lower('_'), now());`);
    refused(
      `create function public.m() returns trigger language plpgsql as $$ begin update public.members set role = 'x' where id = new.id; return new; end $$;
       insert into public.services (id, name) values (1, 'a');`,
      /same migration as a function that changes rows/,
    );
    refused(`create function public.mm() returns void language plpgsql as $$ begin merge into public.a using public.b on a.id = b.id when matched then delete; end $$;`, /MERGE/);
    ok(`create function public.g() returns trigger language plpgsql as $$ begin update public.members set role = 'x' where id = new.id; return new; end $$;`);
    refused(`create function public.h() returns trigger language plpgsql as $$ begin update public.members set role = 'x'; return new; end $$;`, /WHERE/);
  });
});

describe("site migration SQL policy — round 4", () => {
  it("F1: the starter's tables cannot be READ either (a migration runs past their RLS)", () => {
    refused(`insert into public.directory (email) select email from public.profiles;`, /starter/);
    refused(`insert into public.directory (email) select p.email from public.a a join profiles p on p.id = a.id;`, /starter/);
    refused(`create view public.v with (security_invoker = true) as select email from public.profiles;`, /starter/);
    refused(`create function public.f() returns setof text language sql as $$ select email from public.profiles $$;`, /starter/);
    ok(`create table if not exists public.notes (id uuid primary key, owner uuid references public.profiles (id)); alter table public.notes enable row level security;
        create policy n on public.notes for select using (public.is_admin());`);
  });

  it("F2: UPDATE / DELETE inside a function body need the same strict WHERE", () => {
    refused(`create function public.wipe() returns int language plpgsql as $$ begin delete from public.orders; return 1; end $$;`, /WHERE/);
    refused(`create function public.wipe() returns int language plpgsql as $$ begin update public.orders set paid = true where true; return 1; end $$;`, /WHERE/);
    refused(`create function public.wipe() returns void language sql as $$ delete from public.orders where id = id $$;`, /WHERE/);
    ok(`create function public.touch_order() returns trigger language plpgsql as $$ begin update public.orders set seen = true where id = new.order_id; return new; end $$;`);
    ok(`create function public.upsert_count() returns trigger language plpgsql as $$ begin insert into public.counts (k, n) values (new.k, 1) on conflict (k) do update set n = public.counts.n + 1; return new; end $$;`);
    ok(`create function public.cleanup(p_id uuid) returns void language sql as $$ delete from public.carts where id = '00000000-0000-0000-0000-000000000000' and owner = auth.uid() $$;`.replace("and owner = auth.uid() ", ""));
  });
});

describe("site migration SQL policy — re-review 2 (codex F2, F3)", () => {
  it("F2: a trigger body's UPDATE/DELETE cannot use NEW/OLD on the left of its WHERE (always true)", () => {
    refused(`create or replace function public.wipe() returns trigger language plpgsql as $$ begin delete from public.notes where new.id = new.id; return new; end $$;`);
    refused(`create or replace function public.wipe() returns trigger language plpgsql as $$ begin update public.notes set body = 'x' where old.id = 1; return new; end $$;`);
    refused(`create or replace function public.wipe() returns trigger language plpgsql as $$ begin delete from public.notes where id = id; return new; end $$;`);
  });
  it("F2: a row-bounded trigger body still passes", () => {
    ok(`create table public.notes (id bigint primary key, body text);
        alter table public.notes enable row level security;
        create or replace function public.tidy() returns trigger language plpgsql as $$ begin delete from public.notes where id = old.id; return old; end $$;`);
  });
  it("F3: a table that only references profiles (foreign key) and an index on its own table pass", () => {
    ok(`create table public.posts (id bigint primary key, author uuid references public.profiles (id));
        alter table public.posts enable row level security;
        create index posts_author on public.posts (author);`);
  });
  it("F3: CREATE TABLE AS from a starter table is still refused", () => {
    refused(`create table public.leak as select * from public.profiles;`);
  });
});

