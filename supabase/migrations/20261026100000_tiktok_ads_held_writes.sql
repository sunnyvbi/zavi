begin;

do $$
declare r record; definition text; original text;
begin
  for r in select oid, proname from pg_proc where pronamespace = 'public'::regnamespace and proname in
    ('reserve_ad_spend', 'rebase_ad_spend_for_object')
  loop
    original := pg_get_functiondef(r.oid);
    if position('''tiktok''' in original) > 0 then
      raise exception 'tiktok_ads_held_writes: % already names tiktok', r.oid::regproc;
    end if;
    if position('not in (''meta'', ''google'', ''x'', ''reddit'', ''chatgpt'')' in original) = 0 then
      raise exception 'tiktok_ads_held_writes: % platform check no longer matches', r.oid::regproc;
    end if;
    if position('p_platform in (''chatgpt'', ''x'') then 2' in original) = 0 then
      raise exception 'tiktok_ads_held_writes: % spending multiplier no longer matches', r.oid::regproc;
    end if;
    definition := replace(original,
      'not in (''meta'', ''google'', ''x'', ''reddit'', ''chatgpt'')',
      'not in (''meta'', ''google'', ''x'', ''reddit'', ''chatgpt'', ''tiktok'')');
    execute definition;
  end loop;

  select oid into r from pg_proc where pronamespace = 'public'::regnamespace and proname = 'shrink_underdelivering_ad_holds';
  original := pg_get_functiondef(r.oid);
  if position('r.platform not in (''chatgpt'', ''x'')' in original) = 0 then
    raise exception 'tiktok_ads_held_writes: shrink_underdelivering_ad_holds platform skip no longer matches';
  end if;
  execute replace(original, 'r.platform not in (''chatgpt'', ''x'')', 'r.platform not in (''chatgpt'', ''x'', ''tiktok'')');

  for r in select conname, pg_get_constraintdef(oid) as def
    from pg_constraint where contype = 'c' and conrelid = 'public.ad_budget_reservations'::regclass
      and pg_get_constraintdef(oid) like '%platform%'
  loop
    if position('''google''::text' in r.def) = 0 or position('''tiktok''::text' in r.def) > 0 then
      raise exception 'tiktok_ads_held_writes: ad_budget_reservations % platform check no longer matches', r.conname;
    end if;
    execute format('alter table public.ad_budget_reservations drop constraint %I', r.conname);
    execute format('alter table public.ad_budget_reservations add constraint %I %s', r.conname,
      replace(r.def, '''google''::text', '''google''::text, ''tiktok''::text'));
  end loop;
  if not found then
    raise exception 'tiktok_ads_held_writes: ad_budget_reservations has no platform check';
  end if;
end $$;

commit;
