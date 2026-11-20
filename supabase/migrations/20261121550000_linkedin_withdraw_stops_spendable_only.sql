begin;
create or replace function public.ads_consent_stop_linkedin() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if new.revoked_at is not null then
  perform 1 from ads_wallets where tenant_id=new.tenant_id for update;
  insert into ads_campaign_lifecycle(tenant_id,campaign_binding_id,stop_requested_at)
   select c.tenant_id,c.id,new.revoked_at from ads_campaign_binding_details c
   left join ads_campaign_lifecycle l on l.campaign_binding_id=c.id and l.tenant_id=c.tenant_id
   where c.tenant_id=new.tenant_id and c.platform='linkedin' and c.funding_source='wallet'
   and (l.campaign_binding_id is null
    or exists(select 1 from ads_campaign_operations o where o.campaign_binding_id=c.id and o.tenant_id=c.tenant_id
     and o.kind='activate' and o.status in ('pending','uncertain'))
    or (not (l.created_paused and l.activation_attempted_at is null)
     and not (l.stop_requested_at is not null and l.stop_confirmed_at>=l.stop_requested_at
      and (l.activation_attempted_at is null or l.activation_attempted_at<=l.stop_requested_at))))
   on conflict(tenant_id,campaign_binding_id) do update set stop_requested_at=excluded.stop_requested_at;
 end if;
 return new;
end $$;
revoke all on function public.ads_consent_stop_linkedin() from public,anon,authenticated;

update public.ads_campaign_lifecycle l set stop_requested_at=null
 from public.ads_campaign_binding_details c
 where c.id=l.campaign_binding_id and c.tenant_id=l.tenant_id
 and c.platform='linkedin' and c.funding_source='wallet'
 and l.created_paused and l.activation_attempted_at is null
 and l.stop_requested_at is not null and l.stop_requested_at<>date_trunc('milliseconds',l.stop_requested_at)
 and (l.stop_confirmed_at is null or l.stop_confirmed_at<l.stop_requested_at)
 and not exists(select 1 from public.ads_campaign_operations o where o.campaign_binding_id=l.campaign_binding_id
  and o.tenant_id=l.tenant_id and o.kind='activate' and o.status in ('pending','uncertain','succeeded'));
commit;
