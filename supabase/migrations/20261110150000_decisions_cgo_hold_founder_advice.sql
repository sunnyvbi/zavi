
begin;

set lock_timeout = '5s';

alter table public.decisions add column if not exists cgo_hold jsonb;
alter table public.decisions add column if not exists founder_advice jsonb;

create or replace function public.decisions_clear_cgo_hold() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.cgo_hold := null;
  return new;
end $$;

revoke all on function public.decisions_clear_cgo_hold() from public, anon, authenticated;

drop trigger if exists decisions_clear_cgo_hold on public.decisions;
create trigger decisions_clear_cgo_hold
  before update of status on public.decisions
  for each row
  when (old.status = 'proposed' and new.status is distinct from 'proposed' and new.cgo_hold is not null)
  execute function public.decisions_clear_cgo_hold();

create or replace view public.customer_visible_pending_decisions
with (security_invoker = true) as
  select d.*
  from public.decisions d
  where d.status = 'proposed'
    and d.autonomy_at_emit = 'approval'
    and (d.snoozed_until is null or d.snoozed_until <= now())
    and d.decision_class <> all (array['cgo.dispatch-specialist']);

commit;
