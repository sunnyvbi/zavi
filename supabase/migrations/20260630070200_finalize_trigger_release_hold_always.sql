
create or replace function _trg_finalize_run_credits()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not _credits_enforced(NEW.tenant_id)
     and not exists (
       select 1 from tenant_credit_ledger r
       where r.run_id = NEW.id and r.kind = 'reserve'
         and not exists (
           select 1 from tenant_credit_ledger t
           where t.run_id = NEW.id and t.kind in ('settle','refund')
         )
     ) then
    return null;
  end if;
  if OLD.status in ('queued','running','blocked')
     and NEW.status in ('success','parse_failed','error','failed','cancelled','dispatch_error') then
    perform finalize_run_credits(NEW.id, NEW.cost_usd, NEW.status);
  end if;
  return null;
end $$;

do $$
begin
  raise notice '20260630070200: finalize trigger releases hold on (enforced OR open-reserve) + OLD.status includes blocked';
end $$;
