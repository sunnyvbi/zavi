begin;

insert into public.decision_classes (slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity)
values ('x_ads.manage_objects', 'Human-confirmed X Ads campaign deletion, ad-group management, promoted-post associations and targeting edits. Versions and parent ownership are rechecked at execution.', 'approval', 'x_ads.manage_objects', true, false, 'high')
on conflict (slug) do update set description = excluded.description, dispatch_handler = excluded.dispatch_handler, default_autonomy = excluded.default_autonomy, never_auto = excluded.never_auto, click_allowlistable = excluded.click_allowlistable, severity = excluded.severity;

do $$
declare r record; definition text; original text;
begin
  for r in select oid, proname from pg_proc where pronamespace = 'public'::regnamespace and proname in
    ('reserve_ad_spend', 'rebase_ad_spend_for_object', 'record_ad_object_changes', 'record_ad_ledger_read', 'shrink_underdelivering_ad_holds')
  loop
    original := pg_get_functiondef(r.oid);
    definition := replace(original, '''meta'', ''google''', '''meta'', ''google'', ''x''');
    if r.proname in ('reserve_ad_spend', 'rebase_ad_spend_for_object') then
      if position('p_platform = ''chatgpt'' then 2' in definition) = 0 then
        raise exception 'x_ads_management: % spending multiplier no longer matches', r.oid::regproc;
      end if;
      definition := replace(definition, 'p_platform = ''chatgpt'' then 2', 'p_platform in (''chatgpt'', ''x'') then 2');
    end if;
    if r.proname = 'shrink_underdelivering_ad_holds' then
      definition := replace(definition, 'r.platform <> ''chatgpt''', 'r.platform not in (''chatgpt'', ''x'')');
    end if;
    if definition = original then raise exception 'x_ads_management: % platform check no longer matches', r.oid::regproc; end if;
    execute definition;
  end loop;
  for r in select conrelid::regclass as tbl, conname, pg_get_constraintdef(oid) as def
    from pg_constraint where contype = 'c' and conrelid in
      ('public.ad_budget_reservations'::regclass, 'public.ad_campaigns'::regclass, 'public.ad_spend_daily'::regclass, 'public.ad_budget_plan'::regclass, 'public.ad_object_changes'::regclass)
      and pg_get_constraintdef(oid) like '%platform%'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format('alter table %s add constraint %I %s', r.tbl, r.conname, replace(r.def, '''google''::text', '''google''::text, ''x''::text'));
  end loop;
end $$;

commit;
