
begin;

alter table public.email_bulk_sends add column if not exists delivered int not null default 0;
alter table public.email_bulk_sends add column if not exists opens int not null default 0;
alter table public.email_bulk_sends add column if not exists machine_opens int not null default 0;
alter table public.email_bulk_sends add column if not exists clicks int not null default 0;
alter table public.email_bulk_sends add column if not exists unsubscribes int not null default 0;
alter table public.email_bulk_sends add column if not exists delivered_seen_at timestamptz;

create table if not exists public.email_bulk_event_ids (
  sg_event_id text primary key check (char_length(sg_event_id) between 1 and 200),
  seen_at     timestamptz not null default now()
);
create index if not exists email_bulk_event_ids_seen_idx on public.email_bulk_event_ids (seen_at);
alter table public.email_bulk_event_ids enable row level security;
revoke all on public.email_bulk_event_ids from public, anon, authenticated;
grant all on public.email_bulk_event_ids to service_role;

create or replace function public.email_bulk_record_events(p_events jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_new int;
  v_rows int;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'bad_args');
  end if;
  with ev as (
    select distinct on (e->>'id')
           e->>'id' as id,
           (e->>'tenant_id')::uuid as tenant_id,
           (e->>'send_id')::uuid as send_id,
           e->>'kind' as kind
      from jsonb_array_elements(p_events) e
     where jsonb_typeof(e) = 'object'
       and char_length(coalesce(e->>'id', '')) between 1 and 200
       and e->>'tenant_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and e->>'send_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and e->>'kind' in ('delivered', 'open', 'machine_open', 'click')
  ), fresh as (
    insert into email_bulk_event_ids (sg_event_id)
    select id from ev
    on conflict (sg_event_id) do nothing
    returning sg_event_id
  ), agg as (
    select ev.tenant_id, ev.send_id,
           count(*) filter (where ev.kind = 'delivered')    as d,
           count(*) filter (where ev.kind = 'open')         as o,
           count(*) filter (where ev.kind = 'machine_open') as m,
           count(*) filter (where ev.kind = 'click')        as c
      from ev join fresh on fresh.sg_event_id = ev.id
     group by ev.tenant_id, ev.send_id
  ), upd as (
    update email_bulk_sends s
       set delivered = s.delivered + agg.d,
           opens = s.opens + agg.o,
           machine_opens = s.machine_opens + agg.m,
           clicks = s.clicks + agg.c,
           delivered_seen_at = coalesce(s.delivered_seen_at, case when agg.d > 0 then now() end)
      from agg
     where s.id = agg.send_id and s.tenant_id = agg.tenant_id
    returning s.id
  )
  select (select count(*) from fresh), (select count(*) from upd) into v_new, v_rows;
  return jsonb_build_object('ok', true, 'new_events', v_new, 'sends', v_rows);
end $$;
revoke all on function public.email_bulk_record_events(jsonb) from public, anon, authenticated;
grant execute on function public.email_bulk_record_events(jsonb) to service_role;

create table if not exists public.email_unsubscribe_marks (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null,
  marked_at  timestamptz not null default now(),
  primary key (tenant_id, contact_id)
);
alter table public.email_unsubscribe_marks enable row level security;
revoke all on public.email_unsubscribe_marks from public, anon, authenticated;
grant all on public.email_unsubscribe_marks to service_role;

create or replace function public.email_unsubscribe_and_count(p_tenant_id uuid, p_email text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email   text := lower(trim(p_email));
  v_contact uuid;
  v_marked  uuid;
  v_counted int := 0;
begin
  if p_tenant_id is null or v_email is null or v_email = '' then
    raise exception 'email_unsubscribe_and_count: null argument' using errcode = '22023';
  end if;
  insert into email_suppression (tenant_id, email, reason)
  values (p_tenant_id, v_email, 'unsubscribe')
  on conflict (tenant_id, email) do update set reason = excluded.reason;
  select id into v_contact from email_contacts where tenant_id = p_tenant_id and email_norm = v_email;
  if v_contact is null then
    return jsonb_build_object('ok', true, 'new', false, 'sends_counted', 0);
  end if;
  insert into email_unsubscribe_marks (tenant_id, contact_id) values (p_tenant_id, v_contact)
  on conflict (tenant_id, contact_id) do nothing
  returning contact_id into v_marked;
  if v_marked is not null then
    update email_bulk_sends s
       set unsubscribes = s.unsubscribes + 1
      from (select distinct r.send_id
              from email_bulk_send_recipients r
             where r.tenant_id = p_tenant_id and r.contact_id = v_contact and r.status = 'sent') x
     where s.tenant_id = p_tenant_id and s.id = x.send_id
       and not exists (select 1 from email_send_results e
                        where e.rail = 'decisions' and e.card_id = s.decision_id and e.d7_published_at is not null);
    get diagnostics v_counted = row_count;
  end if;
  return jsonb_build_object('ok', true, 'new', v_marked is not null, 'sends_counted', v_counted);
end $$;
revoke all on function public.email_unsubscribe_and_count(uuid, text) from public, anon, authenticated;
grant execute on function public.email_unsubscribe_and_count(uuid, text) to service_role;

create or replace function public.email_bulk_purge_event_ids(p_batch int)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  delete from email_bulk_event_ids
   where sg_event_id in (
     select sg_event_id from email_bulk_event_ids
      where seen_at < now() - interval '3 days'
      order by seen_at limit greatest(1, least(coalesce(p_batch, 5000), 20000)));
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.email_bulk_purge_event_ids(int) from public, anon, authenticated;
grant execute on function public.email_bulk_purge_event_ids(int) to service_role;

commit;
