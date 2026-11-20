
begin;

create table if not exists public.cgo_ad_holds (
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  object_key  text not null check (char_length(object_key) between 1 and 200),
  platform    text not null check (char_length(platform) between 1 and 40),
  object_id   text not null check (char_length(object_id) between 1 and 120),
  name        text check (name is null or char_length(name) <= 200),
  from_usd    numeric(12, 2),
  to_usd      numeric(12, 2),
  reason      text not null check (char_length(reason) between 1 and 200),
  until_on    date,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, object_key)
);

alter table public.cgo_ad_holds enable row level security;

revoke all on table public.cgo_ad_holds from public, anon, authenticated;
grant select on table public.cgo_ad_holds to authenticated;
grant select, insert, update, delete on table public.cgo_ad_holds to service_role;

drop policy if exists cgo_ad_holds_select on public.cgo_ad_holds;
create policy cgo_ad_holds_select on public.cgo_ad_holds
  for select to authenticated
  using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = cgo_ad_holds.tenant_id
    )
  );

commit;
