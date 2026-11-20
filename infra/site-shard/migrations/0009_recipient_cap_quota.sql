
begin;

alter table zsite.quotas add column if not exists max_recipient_creates_per_min integer not null default 30;
alter table zsite.quotas drop constraint if exists quotas_recipient_cap_range;
alter table zsite.quotas add constraint quotas_recipient_cap_range
  check (max_recipient_creates_per_min between 0 and 10000);

grant select (site_id, max_recipient_creates_per_min) on zsite.quotas to zsite_kernel;
drop policy if exists quotas_kernel_site on zsite.quotas;
create policy quotas_kernel_site on zsite.quotas for select to zsite_kernel
  using (site_id = (select zsite.request_site()));

create or replace function zsite.k_recipient_take(p_collection text, p_recipient uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_site uuid := zsite.require_site();
  v_now timestamptz := date_trunc('minute', clock_timestamp());
  v_cap integer;
begin
  if pg_trigger_depth() = 0 then
    raise exception 'not_in_trigger' using errcode = '42501';
  end if;
  select q.max_recipient_creates_per_min into v_cap from zsite.quotas q where q.site_id = v_site;
  v_cap := coalesce(v_cap, 0);
  insert into zsite.recipient_windows as w (site_id, collection, recipient, window_start, n)
  select v_site, p_collection, p_recipient, v_now, 1
  where v_cap > 0
  on conflict (site_id, collection, recipient) do update
     set window_start = case when w.window_start < excluded.window_start then excluded.window_start else w.window_start end,
         n = case when w.window_start < excluded.window_start then 1 else w.n + 1 end
   where w.window_start < excluded.window_start or w.n < v_cap;
  if not found then
    raise exception 'recipient_rate_limited' using errcode = '53400';
  end if;
end $$;
grant create on schema zsite to zsite_kernel;
alter function zsite.k_recipient_take(text, uuid) owner to zsite_kernel;
revoke create on schema zsite from zsite_kernel;
revoke all on function zsite.k_recipient_take(text, uuid) from public;
grant execute on function zsite.k_recipient_take(text, uuid) to zsite_facade, zsite_kernel;

insert into zsite.migrations (version) values ('0009_recipient_cap_quota') on conflict do nothing;

commit;
