begin;
create unique index ads_one_managed_linkedin_advertiser on public.ads_provider_accounts(platform)
 where platform='linkedin' and credential_source='platform';
alter table public.ads_campaign_lifecycle add unique(tenant_id,campaign_binding_id);
alter table public.ads_campaign_lifecycle add column stop_confirmed_at timestamptz;
create view public.ads_campaign_pending_stops as
 select l.tenant_id,l.campaign_binding_id,l.stop_requested_at from ads_campaign_lifecycle l
 join ads_campaign_binding_details c on c.id=l.campaign_binding_id and c.tenant_id=l.tenant_id
 where c.platform='linkedin' and l.stop_requested_at is not null
 and (l.stop_confirmed_at is null or l.stop_confirmed_at<l.stop_requested_at);
revoke all on public.ads_campaign_pending_stops from public,anon,authenticated;
grant select on public.ads_campaign_pending_stops to service_role;

create function public.ads_consent_stop_linkedin() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if new.revoked_at is not null then
  insert into ads_campaign_lifecycle(tenant_id,campaign_binding_id,stop_requested_at)
   select tenant_id,id,new.revoked_at from ads_campaign_binding_details where tenant_id=new.tenant_id and platform='linkedin'
   on conflict(tenant_id,campaign_binding_id) do update set stop_requested_at=excluded.stop_requested_at;
 end if;
 return new;
end $$;
create trigger ads_consent_stop_linkedin after insert or update on ads_wallet_consents for each row execute function ads_consent_stop_linkedin();
revoke all on function ads_consent_stop_linkedin() from public,anon,authenticated;

create table public.ads_campaign_spend_stability(
 tenant_id uuid not null,
 campaign_binding_id uuid primary key,
 observed_cents bigint not null check(observed_cents>=0),
 stable_since timestamptz not null,
 ended_since timestamptz,
 last_observed_at timestamptz not null,
 unique(tenant_id,campaign_binding_id),
 foreign key(campaign_binding_id,tenant_id) references ads_campaign_bindings(id,tenant_id) on delete cascade
);
alter table ads_campaign_spend_stability enable row level security;
revoke all on ads_campaign_spend_stability from public,anon,authenticated;
grant all on ads_campaign_spend_stability to service_role;
create function public.ads_observe_linkedin_spend(p_tenant_id uuid,p_campaign_binding_id uuid,p_spend_cents bigint,p_ended boolean) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare s ads_campaign_spend_stability%rowtype; stamp timestamptz:=clock_timestamp(); final_cents bigint;
begin
 perform 1 from ads_campaign_bindings c join ads_account_bindings b on b.id=c.account_binding_id
  join ads_provider_accounts a on a.id=c.account_id where c.id=p_campaign_binding_id and c.tenant_id=p_tenant_id
  and a.platform='linkedin' and b.funding_source='wallet' for update of c;
 if not found or p_spend_cents is null or p_spend_cents<0 or p_ended is null then raise exception 'verified wallet-funded LinkedIn campaign required'; end if;
 select * into s from ads_campaign_spend_stability where campaign_binding_id=p_campaign_binding_id and tenant_id=p_tenant_id;
 insert into ads_campaign_spend_stability(tenant_id,campaign_binding_id,observed_cents,stable_since,ended_since,last_observed_at)
 values(p_tenant_id,p_campaign_binding_id,p_spend_cents,stamp,case when p_ended then stamp end,stamp)
 on conflict(tenant_id,campaign_binding_id) do update set
  stable_since=case when ads_campaign_spend_stability.observed_cents=excluded.observed_cents then ads_campaign_spend_stability.stable_since else stamp end,
  observed_cents=excluded.observed_cents,
  ended_since=case when p_ended then coalesce(ads_campaign_spend_stability.ended_since,stamp) end,last_observed_at=stamp;
 if s.campaign_binding_id is not null and p_ended and s.observed_cents=p_spend_cents
  and s.stable_since<=stamp-interval '72 hours' and s.ended_since<=stamp-interval '72 hours' then
  select greatest(spent_cents,p_spend_cents) into strict final_cents from ads_campaign_reservations where campaign_binding_id=p_campaign_binding_id and tenant_id=p_tenant_id;
  perform ads_wallet_finalize_bound(p_tenant_id,p_campaign_binding_id,final_cents);
  return true;
 end if;
 return false;
end $$;
revoke all on function ads_observe_linkedin_spend(uuid,uuid,bigint,boolean) from public,anon,authenticated;
grant execute on function ads_observe_linkedin_spend(uuid,uuid,bigint,boolean) to service_role;
create function public.ads_reserve_linkedin_launch(p_tenant_id uuid,p_campaign_binding_id uuid,p_lifetime_cents bigint,p_observed_spend_cents bigint) returns bigint
language plpgsql security definer set search_path=public,pg_temp as $$
declare f ads_campaign_reservations%rowtype; prior bigint:=0;
begin
 perform 1 from ads_campaign_binding_details where id=p_campaign_binding_id and tenant_id=p_tenant_id and platform='linkedin' and funding_source='wallet';
 if not found then raise exception 'wallet-funded LinkedIn binding required'; end if;
 perform 1 from ads_wallets where tenant_id=p_tenant_id for update;
 select * into f from ads_campaign_reservations where tenant_id=p_tenant_id and campaign_binding_id=p_campaign_binding_id;
 if found then prior:=greatest(0,f.reserved_cents-greatest(0,p_observed_spend_cents-f.spent_cents)); end if;
 perform ads_wallet_reserve_bound(p_tenant_id,p_campaign_binding_id,p_lifetime_cents,p_observed_spend_cents);
 update ads_campaign_lifecycle set activation_attempted_at=clock_timestamp() where tenant_id=p_tenant_id and campaign_binding_id=p_campaign_binding_id;
 if not found then raise exception 'launch inventory required'; end if;
 delete from ads_campaign_spend_stability where tenant_id=p_tenant_id and campaign_binding_id=p_campaign_binding_id;
 return prior;
end $$;
revoke all on function ads_reserve_linkedin_launch(uuid,uuid,bigint,bigint) from public,anon,authenticated;
grant execute on function ads_reserve_linkedin_launch(uuid,uuid,bigint,bigint) to service_role;
create function public.ads_release_unsent_linkedin_launch(p_tenant_id uuid,p_campaign_binding_id uuid,p_operation_id uuid,p_prior_reserved_cents bigint) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_prior_reserved_cents is null or p_prior_reserved_cents<0 then raise exception 'invalid prior reservation'; end if;
 perform 1 from ads_campaign_binding_details where id=p_campaign_binding_id and tenant_id=p_tenant_id and platform='linkedin' and funding_source='wallet';
 if not found then raise exception 'wallet-funded LinkedIn binding required'; end if;
 perform 1 from ads_wallets where tenant_id=p_tenant_id for update;
 perform 1 from ads_campaign_operations where id=p_operation_id and tenant_id=p_tenant_id
  and campaign_binding_id=p_campaign_binding_id and kind='activate' and status='pending' for update;
 if not found then return; end if;
 update ads_campaign_reservations set reserved_cents=least(reserved_cents,p_prior_reserved_cents),updated_at=now()
  where tenant_id=p_tenant_id and campaign_binding_id=p_campaign_binding_id;
end $$;
revoke all on function ads_release_unsent_linkedin_launch(uuid,uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function ads_release_unsent_linkedin_launch(uuid,uuid,uuid,bigint) to service_role;
commit;
