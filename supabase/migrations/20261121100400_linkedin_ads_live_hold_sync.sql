begin;

alter table public.ad_hold_live_reads
  drop constraint ad_hold_live_reads_platform_check;
alter table public.ad_hold_live_reads
  add constraint ad_hold_live_reads_platform_check
  check (platform in ('meta', 'google', 'tiktok', 'linkedin'));

do $$
declare
  definition text := pg_get_functiondef('public.sync_ad_holds_to_live(uuid,text[],timestamptz)'::regprocedure);
  old_filter text := 'r.platform in (''meta'', ''google'', ''tiktok'')';
  new_filter text := 'r.platform in (''meta'', ''google'', ''tiktok'', ''linkedin'')';
  old_stops text := '(''PAUSED'', ''CAMPAIGN_PAUSED'', ''ADSET_PAUSED'', ''ARCHIVED'', ''DELETED'', ''REMOVED'', ''ENDED'')';
  new_stops text := '(''PAUSED'', ''CAMPAIGN_PAUSED'', ''ADSET_PAUSED'', ''ARCHIVED'', ''DELETED'', ''REMOVED'', ''ENDED'', ''COMPLETED'', ''CANCELED'', ''PENDING_DELETION'')';
begin
  if position(new_filter in definition) > 0 and position(new_stops in definition) > 0 then
    return;
  end if;
  if position(old_filter in definition) = 0 or position(old_stops in definition) = 0 then
    raise exception 'LinkedIn hold sync: expected platform filter or stop statuses were not found';
  end if;
  execute replace(replace(definition, old_filter, new_filter), old_stops, new_stops);
end $$;

commit;
