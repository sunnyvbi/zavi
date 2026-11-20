
begin;

create or replace function set_tenant_kind(p_tenant_id uuid, p_kind text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_old text;
begin
  if p_kind is null or p_kind not in ('real', 'test') then
    raise exception 'p_kind must be ''real'' or ''test'' (got %)', p_kind
      using errcode = '22023';
  end if;

  select kind into v_old from tenants where id = p_tenant_id;
  if not found then
    raise exception 'tenant % not found', p_tenant_id using errcode = 'P0002';
  end if;

  if v_old = p_kind then
    return v_old;
  end if;

  if v_old = 'real' and p_kind = 'test' then
    perform set_config('app.allow_tenant_kind_downgrade', 'on', true);
  end if;

  update tenants set kind = p_kind where id = p_tenant_id;
  return p_kind;
end $$;

revoke all on function set_tenant_kind(uuid, text) from public;
revoke all on function set_tenant_kind(uuid, text) from anon;
revoke all on function set_tenant_kind(uuid, text) from authenticated;
grant execute on function set_tenant_kind(uuid, text) to service_role;

comment on function set_tenant_kind(uuid, text) is
  'Staff-only manual tenant kind flip (admin /tenants). Arms the real->test downgrade override for the tagging step. Backend-only via assertStaff; EXECUTE = service_role.';

commit;
