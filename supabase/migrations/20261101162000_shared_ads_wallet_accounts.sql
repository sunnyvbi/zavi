begin;

create table public.ads_wallet_consents (
 tenant_id uuid primary key references public.tenants(id) on delete cascade,
 version text not null check (version = 'shared_ads_wallet_v1'),
 actor_user_id uuid not null,
 accepted_at timestamptz not null default now(),
 revoked_at timestamptz
);
create table public.ads_managed_account_grants (
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 account_id uuid not null references public.ads_provider_accounts(id),
 label text not null check (length(label) between 1 and 200),
 billing_verified_at timestamptz not null,
 disabled_at timestamptz,
 primary key(tenant_id,account_id)
);
create view public.ads_managed_account_choices as
 select g.tenant_id,g.account_id,g.label,g.disabled_at,a.platform
 from public.ads_managed_account_grants g join public.ads_provider_accounts a on a.id=g.account_id;
revoke all on public.ads_managed_account_choices from public,anon,authenticated;
grant select on public.ads_managed_account_choices to service_role;

create table public.ads_account_binding_status (
 tenant_id uuid not null,
 account_binding_id uuid primary key,
 disabled_at timestamptz,
 foreign key(account_binding_id,tenant_id) references public.ads_account_bindings(id,tenant_id) on delete cascade
);
create view public.ads_wallet_reservation_details as
 select r.*,c.provider_campaign_id,b.funding_source,a.platform,a.provider_account_id
 from public.ads_campaign_reservations r join public.ads_campaign_bindings c on c.id=r.campaign_binding_id
 join public.ads_account_bindings b on b.id=c.account_binding_id join public.ads_provider_accounts a on a.id=c.account_id;
revoke all on public.ads_wallet_reservation_details from public,anon,authenticated;
grant select on public.ads_wallet_reservation_details to service_role;

create table public.ads_campaign_lifecycle (
 tenant_id uuid not null,
 campaign_binding_id uuid primary key,
 created_paused boolean not null default false,
 provider_group_id text,
 provider_creative_ids text[] not null default '{}',
 activation_attempted_at timestamptz,
 stop_requested_at timestamptz,
 foreign key(campaign_binding_id,tenant_id) references public.ads_campaign_bindings(id,tenant_id) on delete cascade
);
create table public.ads_campaign_final_settlements (
 tenant_id uuid not null,
 campaign_binding_id uuid primary key,
 final_spend_cents bigint not null check(final_spend_cents>=0),
 evidence_ref text not null check(length(evidence_ref) between 1 and 500),
 verified_at timestamptz not null default now(),
 foreign key(campaign_binding_id,tenant_id) references public.ads_campaign_bindings(id,tenant_id) on delete cascade
);
create table public.ads_campaign_operations (
 id uuid primary key,
 tenant_id uuid not null,
 campaign_binding_id uuid not null,
 kind text not null check(kind in ('activate','pause','finalize')),
 payload jsonb not null,
 status text not null default 'pending' check(status in ('pending','succeeded','uncertain','refused')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key(campaign_binding_id,tenant_id) references public.ads_campaign_bindings(id,tenant_id) on delete cascade
);
create unique index ads_campaign_one_unresolved_operation on public.ads_campaign_operations(campaign_binding_id)
 where status in ('pending','uncertain');

create function public.ads_wallet_consent_refill_guard() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if new.auto_refill_enabled and exists(select 1 from ads_wallet_consents where tenant_id=new.tenant_id and revoked_at is not null) then
  new.auto_refill_enabled:=false;
 end if;
 return new;
end $$;
create trigger ads_wallet_consent_refill_guard before insert or update on public.ads_wallets for each row execute function public.ads_wallet_consent_refill_guard();
revoke all on function public.ads_wallet_consent_refill_guard() from public,anon,authenticated;

create function public.ads_register_customer_account(p_tenant_id uuid,p_platform text,p_provider_account_id text,p_currency text,p_credential_ref text)
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
 if a.credential_source<>'tenant_connector' or a.credential_tenant_id is distinct from p_tenant_id
 or a.credential_ref<>p_credential_ref or a.currency<>p_currency then raise exception 'account ownership conflict'; end if;
 insert into ads_account_bindings(tenant_id,account_id,funding_source) values(p_tenant_id,a.id,'provider') on conflict(tenant_id,account_id) do nothing;
 select id into strict b from ads_account_bindings where tenant_id=p_tenant_id and account_id=a.id and funding_source='provider';
 insert into ads_account_binding_status(tenant_id,account_binding_id) values(p_tenant_id,b) on conflict do nothing;
 return b;
end $$;

create function public.ads_use_managed_account(p_tenant_id uuid,p_account_id uuid) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare b uuid;
begin
 perform 1 from ads_managed_account_grants g join ads_provider_accounts a on a.id=g.account_id
 where g.tenant_id=p_tenant_id and g.account_id=p_account_id and g.disabled_at is null
 and a.credential_source='platform' and a.verified_at is not null and a.currency='USD';
 if not found then raise exception 'managed account unavailable'; end if;
 if not exists(select 1 from ads_wallet_consents where tenant_id=p_tenant_id and revoked_at is null) then raise exception 'shared wallet consent required'; end if;
 insert into ads_account_bindings(tenant_id,account_id,funding_source) values(p_tenant_id,p_account_id,'wallet') on conflict(tenant_id,account_id) do nothing;
 select id into strict b from ads_account_bindings where tenant_id=p_tenant_id and account_id=p_account_id and funding_source='wallet';
 insert into ads_account_binding_status(tenant_id,account_binding_id) values(p_tenant_id,b) on conflict do nothing;
 return b;
end $$;

create function public.ads_set_wallet_consent(p_tenant_id uuid,p_actor_user_id uuid,p_version text,p_accept boolean) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_version is distinct from 'shared_ads_wallet_v1' or p_accept is null or p_actor_user_id is null then raise exception 'invalid wallet consent'; end if;
 insert into ads_wallet_consents(tenant_id,version,actor_user_id,revoked_at)
 values(p_tenant_id,p_version,p_actor_user_id,case when p_accept then null else now() end)
 on conflict(tenant_id) do update set version=excluded.version,actor_user_id=excluded.actor_user_id,
 accepted_at=case when p_accept then now() else ads_wallet_consents.accepted_at end,revoked_at=excluded.revoked_at;
 if not p_accept then update ads_wallets set auto_refill_enabled=false,updated_at=now() where tenant_id=p_tenant_id; end if;
end $$;

create function public.ads_account_selection_guard() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 perform 1 from ads_account_bindings b join ads_provider_accounts a on a.id=b.account_id
 where b.id=new.account_binding_id and b.tenant_id=new.tenant_id and a.platform=new.platform
 and not exists(select 1 from ads_account_binding_status s where s.account_binding_id=b.id and s.disabled_at is not null)
 and (b.funding_source='provider' or a.legacy_key='chatgpt_platform' or
   (exists(select 1 from ads_managed_account_grants g where g.tenant_id=b.tenant_id and g.account_id=b.account_id and g.disabled_at is null)
    and exists(select 1 from ads_wallet_consents c where c.tenant_id=b.tenant_id and c.revoked_at is null)));
 if not found then raise exception 'account selection unavailable'; end if;
 return new;
end $$;
create trigger ads_account_selection_guard before insert or update on public.ads_account_selections for each row execute function public.ads_account_selection_guard();

create function public.ads_disable_account_binding(p_tenant_id uuid,p_binding_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from ads_account_bindings where id=p_binding_id and tenant_id=p_tenant_id;
 if not found then raise exception 'account binding not found'; end if;
 insert into ads_account_binding_status(tenant_id,account_binding_id,disabled_at) values(p_tenant_id,p_binding_id,now())
 on conflict(account_binding_id) do update set disabled_at=excluded.disabled_at;
end $$;

create function public.ads_claim_campaign_operation(p_tenant_id uuid,p_id uuid,p_campaign_binding_id uuid,p_kind text,p_payload jsonb) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare o ads_campaign_operations%rowtype;
begin
 perform 1 from ads_campaign_bindings where id=p_campaign_binding_id and tenant_id=p_tenant_id for update;
 if not found then raise exception 'campaign binding not found'; end if;
 select * into o from ads_campaign_operations where id=p_id;
 if found then
  if o.tenant_id<>p_tenant_id or o.campaign_binding_id<>p_campaign_binding_id or o.kind<>p_kind or o.payload<>p_payload then raise exception 'operation request conflict'; end if;
  return false;
 end if;
 insert into ads_campaign_operations(id,tenant_id,campaign_binding_id,kind,payload) values(p_id,p_tenant_id,p_campaign_binding_id,p_kind,p_payload);
 return true;
end $$;

alter table public.ads_campaign_lifecycle enable row level security;
alter table public.ads_campaign_final_settlements enable row level security;
revoke all on public.ads_campaign_lifecycle,public.ads_campaign_final_settlements from public,anon,authenticated;
grant all on public.ads_campaign_lifecycle,public.ads_campaign_final_settlements to service_role;
alter table public.ads_wallet_consents enable row level security;
alter table public.ads_managed_account_grants enable row level security;
alter table public.ads_account_binding_status enable row level security;
alter table public.ads_campaign_operations enable row level security;
revoke all on public.ads_wallet_consents,public.ads_managed_account_grants,public.ads_account_binding_status,public.ads_campaign_operations from public,anon,authenticated;
grant all on public.ads_wallet_consents,public.ads_managed_account_grants,public.ads_account_binding_status,public.ads_campaign_operations to service_role;
revoke all on function public.ads_register_customer_account(uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function public.ads_use_managed_account(uuid,uuid) from public,anon,authenticated;
revoke all on function public.ads_set_wallet_consent(uuid,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.ads_account_selection_guard() from public,anon,authenticated;
revoke all on function public.ads_disable_account_binding(uuid,uuid) from public,anon,authenticated;
revoke all on function public.ads_claim_campaign_operation(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.ads_register_customer_account(uuid,text,text,text,text),public.ads_use_managed_account(uuid,uuid),public.ads_set_wallet_consent(uuid,uuid,text,boolean),public.ads_disable_account_binding(uuid,uuid),public.ads_claim_campaign_operation(uuid,uuid,uuid,text,jsonb) to service_role;
commit;
