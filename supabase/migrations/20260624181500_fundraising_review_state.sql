
create table if not exists fundraising_review_state (
  tenant_id    uuid        not null references tenants(id) on delete cascade,
  investor_id  text        not null,
  state        text        not null default 'undecided'
                 check (state in ('undecided', 'approved', 'saved', 'removed')),
  updated_by   uuid        references auth.users(id) on delete set null,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, investor_id)
);

alter table fundraising_review_state enable row level security;

create policy fundraising_review_state_select on fundraising_review_state
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid()
              and tenant_id = fundraising_review_state.tenant_id)
  );

create or replace function fundraising_set_review_state(
  p_tenant_id   uuid,
  p_investor_id text,
  p_state       text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null then
    raise exception 'fundraising_set_review_state: tenant_id required' using errcode = '22023';
  end if;
  if p_investor_id is null or length(trim(p_investor_id)) = 0 then
    raise exception 'fundraising_set_review_state: investor_id required' using errcode = '22023';
  end if;
  if p_state is null or p_state not in ('undecided', 'approved', 'saved', 'removed') then
    raise exception 'fundraising_set_review_state: invalid state %', p_state using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  insert into fundraising_review_state (tenant_id, investor_id, state, updated_by, updated_at)
  values (p_tenant_id, p_investor_id, p_state, auth.uid(), now())
  on conflict (tenant_id, investor_id) do update set
    state      = excluded.state,
    updated_by = excluded.updated_by,
    updated_at = now();
end $$;

revoke all on function fundraising_set_review_state(uuid, text, text) from public;
grant execute on function fundraising_set_review_state(uuid, text, text) to authenticated;
grant execute on function fundraising_set_review_state(uuid, text, text) to service_role;
