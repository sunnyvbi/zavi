
create table if not exists fundraising_outreach_replied (
  tenant_id    uuid        not null references tenants(id) on delete cascade,
  investor_id  text        not null,
  replied_at   timestamptz not null default now(),
  updated_by   uuid        references auth.users(id) on delete set null,
  primary key (tenant_id, investor_id)
);

alter table fundraising_outreach_replied enable row level security;

create policy fundraising_outreach_replied_select on fundraising_outreach_replied
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid()
              and tenant_id = fundraising_outreach_replied.tenant_id)
  );

create or replace function fundraising_mark_outreach_replied(
  p_tenant_id   uuid,
  p_investor_id text,
  p_replied     boolean
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null then
    raise exception 'fundraising_mark_outreach_replied: tenant_id required' using errcode = '22023';
  end if;
  if p_investor_id is null or length(trim(p_investor_id)) = 0 then
    raise exception 'fundraising_mark_outreach_replied: investor_id required' using errcode = '22023';
  end if;
  if p_replied is null then
    raise exception 'fundraising_mark_outreach_replied: replied required' using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  if p_replied then
    insert into fundraising_outreach_replied (tenant_id, investor_id, replied_at, updated_by)
    values (p_tenant_id, p_investor_id, now(), auth.uid())
    on conflict (tenant_id, investor_id) do update set
      replied_at = now(),
      updated_by = excluded.updated_by;
  else
    delete from fundraising_outreach_replied
    where tenant_id = p_tenant_id and investor_id = p_investor_id;
  end if;
end $$;

revoke all on function fundraising_mark_outreach_replied(uuid, text, boolean) from public;
grant execute on function fundraising_mark_outreach_replied(uuid, text, boolean) to authenticated;
grant execute on function fundraising_mark_outreach_replied(uuid, text, boolean) to service_role;
