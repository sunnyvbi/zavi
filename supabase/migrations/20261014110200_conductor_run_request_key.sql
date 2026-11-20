begin;

alter table public.conductor_runs add column if not exists request_key text;

create unique index if not exists conductor_runs_request_key_uq
  on public.conductor_runs (tenant_id, request_key)
  where request_key is not null;

commit;
