
begin;

create or replace function fundraising_set_investor_email(
  p_tenant_id   uuid,
  p_investor_id uuid,
  p_email       text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email   text;
  v_norm    text;
  v_updated int;
begin
  if p_tenant_id is null or p_investor_id is null then
    raise exception 'fundraising_set_investor_email: tenant_id and investor_id required' using errcode = '22023';
  end if;
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  v_email := nullif(trim(coalesce(p_email, '')), '');
  v_norm  := nullif(lower(trim(coalesce(p_email, ''))), '');

  begin
    update fundraising_investor
       set email            = v_email,
           normalized_email = v_norm,
           updated_at       = now()
     where tenant_id = p_tenant_id
       and id        = p_investor_id;
    get diagnostics v_updated = row_count;
  exception when unique_violation then
    raise exception 'fundraising_set_investor_email: email already assigned to another investor'
      using errcode = '23505';
  end;

  if v_updated = 0 then
    raise exception 'fundraising_set_investor_email: investor not found for tenant' using errcode = '22023';
  end if;
end $$;

revoke all on function fundraising_set_investor_email(uuid, uuid, text) from public;
grant execute on function fundraising_set_investor_email(uuid, uuid, text) to authenticated;
grant execute on function fundraising_set_investor_email(uuid, uuid, text) to service_role;

commit;
