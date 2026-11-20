
begin;

create table if not exists zsite_auth.form_notify_outbox (
  id          bigint generated always as identity primary key,
  site_id     uuid not null,
  collection  text not null,
  record_id   uuid not null,
  attempts    integer not null default 0,
  lease_until timestamptz,
  lease_token uuid,
  created_at  timestamptz not null default now(),
  unique (site_id, collection, record_id)
);
create index if not exists form_notify_outbox_site on zsite_auth.form_notify_outbox (site_id, id);

alter table zsite_auth.form_notify_outbox enable row level security;
revoke all on zsite_auth.form_notify_outbox from public, anon, authenticated, service_role, zsite_broker;

create or replace function zsite_auth.tg_records_form_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_rules jsonb;
begin
  if zsite.claim_site() is distinct from NEW.site_id then return null; end if;
  select c.rules into v_rules from zsite.collections c
   where c.site_id = NEW.site_id and c.name = NEW.collection and c.kind = 'records';
  if v_rules is null or not coalesce(v_rules->'create' ? 'anyone', false) then return null; end if;
  insert into zsite_auth.form_notify_outbox (site_id, collection, record_id)
  values (NEW.site_id, NEW.collection, NEW.id)
  on conflict do nothing;
  return null;
end $$;
revoke all on function zsite_auth.tg_records_form_notify() from public, anon, authenticated, service_role, zsite_broker;

drop trigger if exists records_z_form_notify on zsite.records;
create trigger records_z_form_notify after insert on zsite.records
  for each row execute function zsite_auth.tg_records_form_notify();

create or replace function zsite_auth.form_notify_claim(p_limit integer, p_lease_seconds integer)
returns table (id bigint, lease_token uuid, site_id uuid, collection text, record_id uuid, data jsonb, fields jsonb, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  return query
    with cand as (
      select x.id from (
        select o.id, pg_catalog.row_number() over (partition by o.site_id order by o.id) as rn
          from zsite_auth.form_notify_outbox o
         where (o.lease_until is null or o.lease_until <= pg_catalog.now()) and o.attempts < 8
           and exists (select 1 from zsite.records r
                        where r.site_id = o.site_id and r.collection = o.collection and r.id = o.record_id)) x
       where x.rn <= 20
       order by x.id
       limit least(greatest(coalesce(p_limit, 50), 1), 200)),
    picked as (
      select o.id from zsite_auth.form_notify_outbox o
       where o.id in (select cand.id from cand)
         and (o.lease_until is null or o.lease_until <= pg_catalog.now()) and o.attempts < 8
       for update skip locked),
    leased as (
      update zsite_auth.form_notify_outbox o
         set lease_until = pg_catalog.now() + make_interval(secs => least(greatest(p_lease_seconds, 5), 600)),
             lease_token = gen_random_uuid(),
             attempts = o.attempts + 1
        from picked where o.id = picked.id
      returning o.id, o.lease_token, o.site_id, o.collection, o.record_id)
    select l.id, l.lease_token, l.site_id, l.collection, l.record_id, r.data, c.fields, r.created_at
      from leased l
      join zsite.records r on r.site_id = l.site_id and r.collection = l.collection and r.id = l.record_id
      join zsite.collections c on c.site_id = l.site_id and c.name = l.collection
     order by l.id;
end $$;

create or replace function zsite_auth.form_notify_purge(p_limit integer)
returns table (reason text, n integer)
language plpgsql security definer set search_path = '' as $$
begin
  return query
    with c as (
      select z.id, z.why from (
        select x.id,
               case
                 when not exists (select 1 from zsite.records r
                                   where r.site_id = x.site_id and r.collection = x.collection and r.id = x.record_id)
                   then 'record_deleted'
                 when not exists (select 1 from zsite.sites s where s.site_id = x.site_id and s.status <> 'deleting')
                   then 'site_gone'
                 when x.attempts >= 8 then 'exhausted'
                 when x.created_at < pg_catalog.now() - interval '3 days' then 'expired'
               end as why
          from zsite_auth.form_notify_outbox x
         where x.lease_until is null or x.lease_until <= pg_catalog.now()) z
       where z.why is not null
       limit least(greatest(coalesce(p_limit, 1000), 1), 10000)),
    gone as (
      delete from zsite_auth.form_notify_outbox o using c where o.id = c.id returning c.why)
    select g.why, count(*)::integer from gone g group by g.why;
end $$;

create or replace function zsite_auth.form_notify_backlog(out pending bigint, out oldest_age_s integer)
language sql stable security definer set search_path = '' as $$
  select count(*),
         coalesce(extract(epoch from pg_catalog.now() - min(o.created_at))::integer, 0)
    from zsite_auth.form_notify_outbox o
$$;

create or replace function zsite_auth.form_notify_done(p_leases jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from zsite_auth.form_notify_outbox o
   using jsonb_to_recordset(coalesce(p_leases, '[]'::jsonb)) as l(id bigint, token uuid)
   where o.id = l.id and o.lease_token = l.token;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function zsite_auth.form_notify_defer(p_leases jsonb, p_seconds integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update zsite_auth.form_notify_outbox o
     set lease_until = pg_catalog.now() + make_interval(secs => least(greatest(p_seconds, 1), 86400)),
         lease_token = null,
         attempts = greatest(o.attempts - 1, 0)
    from jsonb_to_recordset(coalesce(p_leases, '[]'::jsonb)) as l(id bigint, token uuid)
   where o.id = l.id and o.lease_token = l.token;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function
  zsite_auth.form_notify_purge(integer),
  zsite_auth.form_notify_backlog(),
  zsite_auth.form_notify_claim(integer, integer),
  zsite_auth.form_notify_done(jsonb),
  zsite_auth.form_notify_defer(jsonb, integer)
  from public, anon, authenticated, service_role;
grant execute on function
  zsite_auth.form_notify_purge(integer),
  zsite_auth.form_notify_backlog(),
  zsite_auth.form_notify_claim(integer, integer),
  zsite_auth.form_notify_done(jsonb),
  zsite_auth.form_notify_defer(jsonb, integer)
  to zsite_broker;

insert into zsite.migrations (version) values ('1030_form_notifications') on conflict do nothing;

commit;
