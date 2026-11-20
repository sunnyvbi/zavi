
create table if not exists public.activity_events (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  occurred_at  timestamptz not null default now(),
  ingested_at  timestamptz not null default now(),
  actor_type   text not null check (actor_type in ('operator', 'staff', 'agent', 'system')),
  actor_id     text,
  verb         text not null check (char_length(verb) between 1 and 80),
  object_type  text,
  object_id    text,
  source       text not null default 'server'
               check (source in ('web', 'server', 'agent', 'slack', 'sdk', 'system')),
  props        jsonb not null default '{}'::jsonb,
  confidence   text not null default 'exact'
               check (confidence in ('exact', 'inferred', 'narrow_artifact_only')),
  dedupe_key   text,
  run_id       uuid
);

comment on table public.activity_events is
  'Reusable low-volume tenant activity-milestone spine (semantic events only; raw telemetry stays in source tables). Activation analytics is the first consumer.';

create index if not exists activity_events_tenant_time
  on public.activity_events (tenant_id, occurred_at desc);
create index if not exists activity_events_tenant_verb_time
  on public.activity_events (tenant_id, verb, occurred_at desc);
create index if not exists activity_events_verb_time
  on public.activity_events (verb, occurred_at desc);
create unique index if not exists activity_events_dedupe_uq
  on public.activity_events (tenant_id, dedupe_key)
  where dedupe_key is not null;

alter table public.activity_events enable row level security;

create or replace function public.tg_activity_connector_connected()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.activity_events
    (tenant_id, occurred_at, actor_type, actor_id, verb, object_type, object_id, source, props, confidence, dedupe_key)
  values
    (new.tenant_id,
     coalesce(new.connected_at, now()),
     'operator', null,
     'connector.connected', 'connector', new.slug,
     'server',
     jsonb_build_object('slug', new.slug),
     'exact',
     'connector.connected:' || new.slug)
  on conflict (tenant_id, dedupe_key) where dedupe_key is not null do nothing;
  return new;
end;
$$;

drop trigger if exists activity_connector_connected on public.connector_metadata;
create trigger activity_connector_connected
  after insert on public.connector_metadata
  for each row execute function public.tg_activity_connector_connected();

create or replace function public.tg_activity_deliverable_produced()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.activity_events
    (tenant_id, occurred_at, actor_type, actor_id, verb, object_type, object_id, source, props, confidence, dedupe_key, run_id)
  values
    (new.tenant_id,
     coalesce(new.created_at, now()),
     'agent', null,
     'deliverable.produced', 'deliverable', new.filename,
     'agent',
     jsonb_build_object('filename', new.filename, 'mime', new.mime, 'bytes', new.bytes),
     'narrow_artifact_only',
     'deliverable.produced:' || new.run_id::text || ':' || new.filename,
     new.run_id)
  on conflict (tenant_id, dedupe_key) where dedupe_key is not null do nothing;
  return new;
end;
$$;

drop trigger if exists activity_deliverable_produced on public.run_artifacts;
create trigger activity_deliverable_produced
  after insert on public.run_artifacts
  for each row execute function public.tg_activity_deliverable_produced();

insert into public.activity_events
  (tenant_id, occurred_at, actor_type, verb, object_type, object_id, source, props, confidence, dedupe_key)
select cm.tenant_id, coalesce(cm.connected_at, now()), 'operator',
       'connector.connected', 'connector', cm.slug, 'server',
       jsonb_build_object('slug', cm.slug), 'inferred',
       'connector.connected:' || cm.slug
from public.connector_metadata cm
on conflict (tenant_id, dedupe_key) where dedupe_key is not null do nothing;

insert into public.activity_events
  (tenant_id, occurred_at, actor_type, verb, object_type, object_id, source, props, confidence, dedupe_key, run_id)
select ra.tenant_id, coalesce(ra.created_at, now()), 'agent',
       'deliverable.produced', 'deliverable', ra.filename, 'agent',
       jsonb_build_object('filename', ra.filename, 'mime', ra.mime, 'bytes', ra.bytes),
       'narrow_artifact_only',
       'deliverable.produced:' || ra.run_id::text || ':' || ra.filename, ra.run_id
from public.run_artifacts ra
on conflict (tenant_id, dedupe_key) where dedupe_key is not null do nothing;
