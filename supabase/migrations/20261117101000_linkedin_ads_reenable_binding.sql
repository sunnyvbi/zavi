begin;
create or replace function public.ads_enable_account_binding(p_tenant_id uuid,p_binding_id uuid,p_platform text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from ads_account_bindings b join ads_provider_accounts a on a.id=b.account_id
 where b.id=p_binding_id and b.tenant_id=p_tenant_id and b.funding_source='provider'
 and a.platform=p_platform and a.credential_source='tenant_connector' and a.credential_tenant_id=p_tenant_id
 for update of b;
 if not found then return false; end if;
 insert into ads_account_binding_status(tenant_id,account_binding_id,disabled_at) values(p_tenant_id,p_binding_id,null)
 on conflict(account_binding_id) do update set disabled_at=null;
 return true;
end $$;
revoke all on function public.ads_enable_account_binding(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.ads_enable_account_binding(uuid,uuid,text) to service_role;
commit;
