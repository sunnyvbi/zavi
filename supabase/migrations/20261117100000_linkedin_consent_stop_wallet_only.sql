begin;
create or replace view public.ads_campaign_pending_stops as
 select l.tenant_id,l.campaign_binding_id,l.stop_requested_at,c.funding_source from ads_campaign_lifecycle l
 join ads_campaign_binding_details c on c.id=l.campaign_binding_id and c.tenant_id=l.tenant_id
 where c.platform='linkedin' and l.stop_requested_at is not null
 and (l.stop_confirmed_at is null or l.stop_confirmed_at<l.stop_requested_at);
revoke all on public.ads_campaign_pending_stops from public,anon,authenticated;
grant select on public.ads_campaign_pending_stops to service_role;

create or replace function public.ads_consent_stop_linkedin() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if new.revoked_at is not null then
  insert into ads_campaign_lifecycle(tenant_id,campaign_binding_id,stop_requested_at)
   select tenant_id,id,new.revoked_at from ads_campaign_binding_details
   where tenant_id=new.tenant_id and platform='linkedin' and funding_source='wallet'
   on conflict(tenant_id,campaign_binding_id) do update set stop_requested_at=excluded.stop_requested_at;
 end if;
 return new;
end $$;
revoke all on function public.ads_consent_stop_linkedin() from public,anon,authenticated;

update public.ads_campaign_lifecycle l set stop_requested_at=null
 from public.ads_campaign_binding_details c, public.ads_wallet_consents w
 where c.id=l.campaign_binding_id and c.tenant_id=l.tenant_id
 and c.platform='linkedin' and c.funding_source<>'wallet'
 and w.tenant_id=l.tenant_id
 and (l.stop_requested_at=w.revoked_at
  or (l.stop_requested_at<w.accepted_at and l.stop_requested_at<>date_trunc('milliseconds',l.stop_requested_at)))
 and (l.stop_confirmed_at is null or l.stop_confirmed_at<l.stop_requested_at);
commit;
