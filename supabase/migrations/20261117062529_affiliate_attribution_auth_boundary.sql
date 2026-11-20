do $$
declare
  function_owner oid;
begin
  select proowner into function_owner from pg_proc
    where oid = 'public.affiliate_attribute(uuid,uuid,text,text,uuid)'::regprocedure;
  if not exists (select 1 from pg_roles where oid = function_owner and (rolsuper or rolbypassrls)) then
    raise exception 'affiliate_attribute owner must bypass forced RLS; review the function owner before applying';
  end if;
  if not has_schema_privilege(function_owner, 'auth', 'USAGE')
    or not has_table_privilege(function_owner, 'auth.users', 'SELECT') then
    raise exception 'affiliate_attribute owner cannot read auth.users; review the function owner before applying';
  end if;
end $$;

alter function public.affiliate_attribute(uuid, uuid, text, text, uuid) security definer;
alter function public.affiliate_attribute(uuid, uuid, text, text, uuid) set search_path = public, pg_temp;
revoke all on function public.affiliate_attribute(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.affiliate_attribute(uuid, uuid, text, text, uuid) to service_role;
