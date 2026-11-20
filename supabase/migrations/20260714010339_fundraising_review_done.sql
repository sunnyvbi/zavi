
alter table fundraising_round_config
  add column if not exists review_done_at timestamptz;

create or replace function fundraising_set_review_done(
  p_tenant_id uuid,
  p_done      boolean
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null then
    raise exception 'fundraising_set_review_done: tenant_id required' using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  insert into fundraising_round_config (tenant_id, review_done_at, updated_by, updated_at)
  values (
    p_tenant_id,
    case when p_done then now() else null end,
    auth.uid(),
    now()
  )
  on conflict (tenant_id) do update set
    review_done_at = case when p_done then now() else null end,
    updated_by     = auth.uid(),
    updated_at     = now();
end $$;

revoke all on function fundraising_set_review_done(uuid, boolean) from public;
grant execute on function fundraising_set_review_done(uuid, boolean) to authenticated;
grant execute on function fundraising_set_review_done(uuid, boolean) to service_role;
