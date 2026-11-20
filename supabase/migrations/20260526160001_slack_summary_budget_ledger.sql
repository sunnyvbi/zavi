
create table slack_summary_budget_ledger (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  day        date not null,
  cents      int  not null default 0,
  count      int  not null default 0,
  primary key (tenant_id, day)
);

alter table slack_summary_budget_ledger enable row level security;

create or replace function slack_summary_budget_increment(
  p_tenant_id uuid,
  p_cents     int,
  p_cap_cents int
) returns table (new_cents int, new_count int, over boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_cents int;
  v_count int;
begin
  insert into slack_summary_budget_ledger (tenant_id, day, cents, count)
  values (p_tenant_id, current_date, p_cents, 1)
  on conflict (tenant_id, day) do update
    set cents = slack_summary_budget_ledger.cents + p_cents,
        count = slack_summary_budget_ledger.count + 1
  returning cents, count into v_cents, v_count;

  if v_cents > p_cap_cents then
    update slack_summary_budget_ledger
       set cents = cents - p_cents,
           count = count - 1
     where tenant_id = p_tenant_id
       and day = current_date;
    return query select v_cents - p_cents, v_count - 1, true;
    return;
  end if;

  return query select v_cents, v_count, false;
end $$;

revoke all on function slack_summary_budget_increment(uuid, int, int) from public;
grant execute on function slack_summary_budget_increment(uuid, int, int) to service_role;
