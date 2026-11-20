begin;
create table public.reddit_ad_operations (
  tenant_id uuid not null references public.tenants(id),
  operation_key text not null check (operation_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  step text not null,
  action_id uuid not null,
  foreign key (tenant_id, action_id) references public.channel_actions(tenant_id, id),
  state text not null check (state in ('running','complete','failed','unknown')),
  request_hash text not null,
  request jsonb not null,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, operation_key, step)
);
alter table public.reddit_ad_operations enable row level security;
revoke all on public.reddit_ad_operations from anon, authenticated;
grant all on public.reddit_ad_operations to service_role;

create table public.reddit_ad_authority (
  tenant_id uuid not null references public.tenants(id),
  ad_account_id text not null,
  limits jsonb not null,
  action_id uuid not null,
  foreign key (tenant_id, action_id) references public.channel_actions(tenant_id, id),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, ad_account_id)
);
alter table public.reddit_ad_authority enable row level security;
revoke all on public.reddit_ad_authority from anon, authenticated;
grant all on public.reddit_ad_authority to service_role;

create table public.reddit_ad_monitor_state (
  tenant_id uuid primary key references public.tenants(id),
  fingerprint text not null,
  issues jsonb not null,
  checked_at timestamptz not null default now()
);
alter table public.reddit_ad_monitor_state enable row level security;
revoke all on public.reddit_ad_monitor_state from anon, authenticated;
grant all on public.reddit_ad_monitor_state to service_role;

do $$
declare r record; definition text; original text;
begin
  for r in select oid from pg_proc where pronamespace = 'public'::regnamespace and proname in
    ('reserve_ad_spend','rebase_ad_spend_for_object','record_ad_object_changes')
  loop
    original := pg_get_functiondef(r.oid);
    definition := replace(original, '''meta'', ''google''', '''meta'', ''google'', ''reddit''');
    definition := replace(definition, '''ad_set'', ''campaign''', '''ad_set'', ''campaign'', ''ad_group'', ''ad''');
    if definition = original then raise exception 'reddit_ads_execution: % no longer matches the expected platform or level check', r.oid::regproc; end if;
    execute definition;
  end loop;
  for r in select oid from pg_proc where pronamespace = 'public'::regnamespace and proname = 'reconcile_channel_action_exec'
  loop
    original := pg_get_functiondef(r.oid);
    definition := replace(original,
      'if v_row.exec_class is distinct from ''email_campaign.create_and_send'' then',
      'if v_row.exec_class is distinct from ''email_campaign.create_and_send'' and coalesce(v_row.exec_class not in (''reddit_ads.prepare_campaign'', ''reddit_ads.launch_campaign'', ''reddit_ads.update_budget'', ''reddit_ads.set_object_status''), true) then');
    definition := replace(definition,
      'if nullif(v_row.exec_progress->>''campaign_id'', '''') is null then',
      'if (v_row.exec_class = ''email_campaign.create_and_send'' and nullif(v_row.exec_progress->>''campaign_id'', '''') is null) or (v_row.exec_class like ''reddit_ads.%'' and not exists (select 1 from reddit_ad_operations o where o.tenant_id = p_tenant_id and (o.action_id = p_action_id or o.operation_key = v_row.exec_payload->>''operation_key''))) then');
    definition := replace(definition,
      'v_row.exec_result->>''code'' = ''exec_outcome_unknown''',
      '(v_row.exec_result->>''code'' = ''exec_outcome_unknown'' or (v_row.exec_class like ''reddit_ads.%'' and v_row.exec_result->>''code'' = ''exec_partial''))');
    if definition = original then raise exception 'reddit_ads_execution: reconcile_channel_action_exec no longer matches the expected text'; end if;
    execute definition;
  end loop;
  for r in select conrelid::regclass as tbl, conname, pg_get_constraintdef(oid) as def
    from pg_constraint where contype = 'c' and conrelid in ('public.ad_budget_reservations'::regclass, 'public.ad_object_changes'::regclass)
      and pg_get_constraintdef(oid) like '%platform%'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format('alter table %s add constraint %I %s', r.tbl, r.conname, replace(r.def, '''google''::text', '''google''::text, ''reddit''::text'));
  end loop;
  for r in select conname from pg_constraint where conrelid = 'public.ad_object_changes'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%level%'
  loop
    execute format('alter table public.ad_object_changes drop constraint %I', r.conname);
  end loop;
  alter table public.ad_object_changes add constraint ad_object_changes_level_check check (level is null or level in ('ad_set','campaign','ad_group','ad'));
end $$;
commit;
