begin;
create function public.ads_save_chatgpt_customer_account(p_tenant_id uuid,p_provider_account_id text,p_currency text,p_api_key text) returns uuid
language plpgsql security definer set search_path=public,vault,pg_temp as $$
declare a ads_provider_accounts%rowtype; b uuid; k text; old_secret uuid; new_secret uuid;
begin
 if p_provider_account_id is null or length(p_provider_account_id) not between 1 and 200
 or p_currency is null or p_currency!~'^[A-Z]{3}$' or p_api_key is null or length(p_api_key) not between 10 and 4096 then raise exception 'invalid account'; end if;
 k:='chatgpt_ads.account.'||md5(p_provider_account_id)||'.api_key';
 perform pg_advisory_xact_lock(hashtextextended('ads-customer:'||p_tenant_id::text||':'||k,0));
 insert into ads_provider_accounts(platform,provider_account_id,currency,verified_at,credential_source,credential_ref,credential_tenant_id)
 values('chatgpt',p_provider_account_id,p_currency,now(),'tenant_connector',k,p_tenant_id)
 on conflict(platform,provider_account_id) do nothing;
 select * into strict a from ads_provider_accounts where platform='chatgpt' and provider_account_id=p_provider_account_id for update;
 if a.credential_source<>'tenant_connector' or a.credential_tenant_id is distinct from p_tenant_id or a.currency<>p_currency or a.credential_ref<>k then raise exception 'account ownership conflict'; end if;
 select vault_secret_id into old_secret from public.secrets where tenant_id=p_tenant_id and key=k;
 new_secret:=vault.create_secret(p_api_key);
 insert into public.secrets(tenant_id,key,vault_secret_id) values(p_tenant_id,k,new_secret)
 on conflict(tenant_id,key) do update set vault_secret_id=excluded.vault_secret_id;
 if old_secret is not null then delete from vault.secrets where id=old_secret; end if;
 insert into ads_account_bindings(tenant_id,account_id,funding_source) values(p_tenant_id,a.id,'provider') on conflict(tenant_id,account_id) do nothing;
 select id into strict b from ads_account_bindings where tenant_id=p_tenant_id and account_id=a.id and funding_source='provider';
 insert into ads_account_binding_status(tenant_id,account_binding_id) values(p_tenant_id,b) on conflict do nothing;
 return b;
end $$;
revoke all on function public.ads_save_chatgpt_customer_account(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.ads_save_chatgpt_customer_account(uuid,text,text,text) to service_role;
commit;
