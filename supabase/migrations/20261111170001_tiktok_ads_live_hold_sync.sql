begin;

alter table public.ad_hold_live_reads
  drop constraint ad_hold_live_reads_platform_check;
alter table public.ad_hold_live_reads
  add constraint ad_hold_live_reads_platform_check
  check (platform in ('meta', 'google', 'tiktok'));

do $$
declare
  definition text := pg_get_functiondef('public.sync_ad_holds_to_live(uuid,text[],timestamptz)'::regprocedure);
  old_filter text := 'r.platform in (''meta'', ''google'')';
begin
  if position(old_filter in definition) = 0 then
    raise exception 'TikTok hold sync: expected platform filter was not found';
  end if;
  execute replace(definition, old_filter, 'r.platform in (''meta'', ''google'', ''tiktok'')');
end $$;

commit;
