do $$
declare
  r record;
  original text;
  definition text;
begin
  for r in select oid from pg_proc where pronamespace = 'public'::regnamespace and proname = 'reconcile_channel_action_exec'
  loop
    original := pg_get_functiondef(r.oid);
    definition := replace(original,
      '''reddit_ads.prepare_campaign'', ''reddit_ads.launch_campaign'', ''reddit_ads.update_budget'', ''reddit_ads.set_object_status''',
      '''reddit_ads.prepare_campaign'', ''reddit_ads.launch_campaign'', ''reddit_ads.update_budget'', ''reddit_ads.update_targeting'', ''reddit_ads.update_ad'', ''reddit_ads.replace_creative'', ''reddit_ads.set_object_status''');
    if definition = original then raise exception 'reddit_ads_edit_and_resume_classes: reconcile_channel_action_exec no longer matches the expected text'; end if;
    execute definition;
  end loop;
end $$;
