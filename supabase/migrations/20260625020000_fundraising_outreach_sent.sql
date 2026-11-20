
create table if not exists fundraising_outreach_sent (
  tenant_id    uuid        not null references tenants(id) on delete cascade,
  investor_id  text        not null,
  channel      text        not null
                 check (channel in ('email', 'linkedin', 'twitter', 'warm_intro')),
  sent_at      timestamptz not null default now(),
  updated_by   uuid        references auth.users(id) on delete set null,
  primary key (tenant_id, investor_id, channel)
);

alter table fundraising_outreach_sent enable row level security;

create policy fundraising_outreach_sent_select on fundraising_outreach_sent
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid()
              and tenant_id = fundraising_outreach_sent.tenant_id)
  );

create or replace function fundraising_mark_outreach_sent(
  p_tenant_id   uuid,
  p_investor_id text,
  p_channel     text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null then
    raise exception 'fundraising_mark_outreach_sent: tenant_id required' using errcode = '22023';
  end if;
  if p_investor_id is null or length(trim(p_investor_id)) = 0 then
    raise exception 'fundraising_mark_outreach_sent: investor_id required' using errcode = '22023';
  end if;
  if p_channel is null or p_channel not in ('email', 'linkedin', 'twitter', 'warm_intro') then
    raise exception 'fundraising_mark_outreach_sent: invalid channel %', p_channel using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  insert into fundraising_outreach_sent (tenant_id, investor_id, channel, sent_at, updated_by)
  values (p_tenant_id, p_investor_id, p_channel, now(), auth.uid())
  on conflict (tenant_id, investor_id, channel) do update set
    sent_at    = now(),
    updated_by = excluded.updated_by;
end $$;

revoke all on function fundraising_mark_outreach_sent(uuid, text, text) from public;
grant execute on function fundraising_mark_outreach_sent(uuid, text, text) to authenticated;
grant execute on function fundraising_mark_outreach_sent(uuid, text, text) to service_role;
