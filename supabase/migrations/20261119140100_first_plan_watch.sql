
create table if not exists public.first_plan_watch (
  tenant_id            uuid primary key references public.tenants(id) on delete cascade,
  setup_connectors_at  timestamptz not null,
  next_check_at        timestamptz not null,
  resolved_at          timestamptz,
  resolved_reason      text check (resolved_reason in ('plan', 'excluded')),
  alert_bucket         text,
  alert_emailed_bucket text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists first_plan_watch_due_idx
  on public.first_plan_watch (next_check_at, tenant_id)
  where resolved_at is null;

alter table public.first_plan_watch enable row level security;
revoke all on table public.first_plan_watch from public, anon, authenticated;
grant all on table public.first_plan_watch to service_role;

create or replace function public.enroll_first_plan_watch()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.setup_connectors_at is not null
     and (tg_op = 'INSERT' or old.setup_connectors_at is null) then
    insert into public.first_plan_watch (tenant_id, setup_connectors_at, next_check_at)
    values (new.tenant_id, new.setup_connectors_at, new.setup_connectors_at + interval '3 minutes')
    on conflict (tenant_id) do nothing;
  end if;
  return new;
end $$;

revoke all on function public.enroll_first_plan_watch() from public, anon, authenticated;

drop trigger if exists tenant_first_run_progress_enroll_first_plan_watch on public.tenant_first_run_progress;
create trigger tenant_first_run_progress_enroll_first_plan_watch
  after insert or update of setup_connectors_at on public.tenant_first_run_progress
  for each row execute function public.enroll_first_plan_watch();

insert into public.first_plan_watch (tenant_id, setup_connectors_at, next_check_at)
select p.tenant_id, p.setup_connectors_at, greatest(now(), p.setup_connectors_at + interval '3 minutes')
  from public.tenant_first_run_progress p
 where p.setup_connectors_at >= now() - interval '24 hours'
on conflict (tenant_id) do nothing;

alter table public.growth_strategy_delivery
  add column if not exists ready_email_settled_at timestamptz;

create index if not exists growth_strategy_delivery_ready_email_due_idx
  on public.growth_strategy_delivery (updated_at, run_id)
  where phase = 'applied' and plan_id is not null and ready_email_settled_at is null;
