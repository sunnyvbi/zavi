begin;

alter table public.ads_provider_accounts add column claim_released_at timestamptz;

create or replace function public._ads_linkedin_account_in_use(p_account_id uuid,p_tenant_id uuid)
returns boolean language plpgsql stable set search_path=public,pg_temp as $$
begin
 return exists(
  select 1 from ads_campaign_bindings c
   where c.account_id=p_account_id and c.tenant_id=p_tenant_id
   and (exists(select 1 from ad_budget_reservations r
                where r.tenant_id=p_tenant_id and r.platform='linkedin' and r.object_id=c.id::text
                and r.status in ('reserved','committed'))
        or exists(select 1 from ads_campaign_operations o
                   where o.campaign_binding_id=c.id and o.status in ('pending','uncertain'))
        or exists(select 1 from ads_campaign_lifecycle l
                   where l.campaign_binding_id=c.id and l.stop_requested_at is not null
                   and (l.stop_confirmed_at is null or l.stop_confirmed_at<l.stop_requested_at))));
end $$;
revoke all on function public._ads_linkedin_account_in_use(uuid,uuid) from public,anon,authenticated;

create or replace function public.ads_provider_identity_immutable() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if (new.id,new.platform,new.credential_source,new.credential_ref,new.legacy_key)
 is distinct from (old.id,old.platform,old.credential_source,old.credential_ref,old.legacy_key)
 or (old.provider_account_id is not null and (new.provider_account_id,new.currency) is distinct from (old.provider_account_id,old.currency))
 then raise exception 'ads account identity is immutable'; end if;
 if new.credential_tenant_id is distinct from old.credential_tenant_id and not (
   old.platform='linkedin' and old.credential_source='tenant_connector' and new.credential_tenant_id is not null
   and new.claim_released_at is null
   and (old.claim_released_at is not null or not exists(
     select 1 from connector_metadata m where m.tenant_id=old.credential_tenant_id and m.slug='linkedin_ads'))
   and not _ads_linkedin_account_in_use(old.id,old.credential_tenant_id))
 then raise exception 'ads account identity is immutable'; end if;
 return new;
end $$;
revoke all on function public.ads_provider_identity_immutable() from public,anon,authenticated;

create or replace function public.ads_register_customer_account(p_tenant_id uuid,p_platform text,p_provider_account_id text,p_currency text,p_credential_ref text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare a ads_provider_accounts%rowtype; b uuid;
begin
 if p_platform not in ('chatgpt','linkedin') or p_credential_ref is null
 or (p_platform='linkedin' and p_credential_ref<>'linkedin_ads.access_token')
 or (p_platform='chatgpt' and p_credential_ref<>'chatgpt_ads.access_token') then raise exception 'unsupported account credential'; end if;
 insert into ads_provider_accounts(platform,provider_account_id,currency,verified_at,credential_source,credential_ref,credential_tenant_id)
 values(p_platform,p_provider_account_id,p_currency,now(),'tenant_connector',p_credential_ref,p_tenant_id)
 on conflict(platform,provider_account_id) do nothing;
 select * into strict a from ads_provider_accounts where platform=p_platform and provider_account_id=p_provider_account_id for update;
 if p_platform='linkedin' and a.credential_source='tenant_connector' and a.credential_ref=p_credential_ref
 and a.currency=p_currency and a.credential_tenant_id is distinct from p_tenant_id
 and (a.claim_released_at is not null or not exists(
   select 1 from connector_metadata m where m.tenant_id=a.credential_tenant_id and m.slug='linkedin_ads'))
 and not _ads_linkedin_account_in_use(a.id,a.credential_tenant_id) then
  update ads_provider_accounts set credential_tenant_id=p_tenant_id,claim_released_at=null,verified_at=now()
   where id=a.id returning * into strict a;
 elsif a.credential_tenant_id=p_tenant_id and a.claim_released_at is not null then
  update ads_provider_accounts set claim_released_at=null,verified_at=now() where id=a.id returning * into strict a;
 end if;
 if a.credential_source<>'tenant_connector' or a.credential_tenant_id is distinct from p_tenant_id
 or a.credential_ref<>p_credential_ref or a.currency<>p_currency then raise exception 'account ownership conflict'; end if;
 insert into ads_account_bindings(tenant_id,account_id,funding_source) values(p_tenant_id,a.id,'provider') on conflict(tenant_id,account_id) do nothing;
 select id into strict b from ads_account_bindings where tenant_id=p_tenant_id and account_id=a.id and funding_source='provider';
 insert into ads_account_binding_status(tenant_id,account_binding_id) values(p_tenant_id,b) on conflict do nothing;
 return b;
end $$;

create function public.ads_release_customer_account_claim(p_tenant_id uuid,p_platform text,p_provider_account_id text default null)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer;
begin
 if p_tenant_id is null or p_platform is distinct from 'linkedin' then raise exception 'unsupported account claim release'; end if;
 update ads_provider_accounts set claim_released_at=now()
  where platform=p_platform and credential_source='tenant_connector' and credential_tenant_id=p_tenant_id
  and claim_released_at is null and (p_provider_account_id is null or provider_account_id=p_provider_account_id)
  and not _ads_linkedin_account_in_use(id,p_tenant_id);
 get diagnostics n=row_count;
 return n;
end $$;

revoke all on function public.ads_register_customer_account(uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function public.ads_release_customer_account_claim(uuid,text,text) from public,anon,authenticated;
grant execute on function public.ads_register_customer_account(uuid,text,text,text,text),public.ads_release_customer_account_claim(uuid,text,text) to service_role;
commit;
