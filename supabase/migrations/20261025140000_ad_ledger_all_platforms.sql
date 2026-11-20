begin;

do $$
declare r record; definition text; original text;
begin
  for r in select oid, proname from pg_proc where pronamespace = 'public'::regnamespace and proname in
    ('record_ad_ledger_read', 'record_ad_object_changes')
  loop
    original := pg_get_functiondef(r.oid);
    definition := replace(original, '''meta'', ''google''',
      '''meta'', ''google'', ''tiktok'', ''pinterest'', ''snapchat'', ''microsoft'', ''apple'', ''spotify'', ''linkedin''');
    if definition = original then raise exception 'ad_ledger_all_platforms: % platform check no longer matches', r.oid::regproc; end if;
    execute definition;
  end loop;
  for r in select conrelid::regclass as tbl, conname, pg_get_constraintdef(oid) as def
    from pg_constraint where contype = 'c' and conrelid in
      ('public.ad_campaigns'::regclass, 'public.ad_spend_daily'::regclass, 'public.ad_object_changes'::regclass)
      and pg_get_constraintdef(oid) like '%platform%'
  loop
    if position('''google''::text' in r.def) = 0 then
      raise exception 'ad_ledger_all_platforms: % % platform check no longer matches', r.tbl, r.conname;
    end if;
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format('alter table %s add constraint %I %s', r.tbl, r.conname, replace(r.def, '''google''::text',
      '''google''::text, ''tiktok''::text, ''pinterest''::text, ''snapchat''::text, ''microsoft''::text, ''apple''::text, ''spotify''::text, ''linkedin''::text'));
  end loop;
end $$;

alter table public.ad_budgets
  add column if not exists read_failed jsonb not null default '{}'::jsonb;

do $$
declare r record; definition text; original text;
begin
  select oid into r from pg_proc where pronamespace = 'public'::regnamespace and proname = 'reserve_ad_spend';
  original := pg_get_functiondef(r.oid);
  if position('v_today := _ad_budget_today();' in original) = 0 then
    raise exception 'ad_ledger_all_platforms: reserve_ad_spend anchor no longer matches';
  end if;
  definition := replace(original, 'v_today := _ad_budget_today();',
'if v_budget.read_failed ? p_platform and not exists (
    select 1 from ad_budget_reservations
     where budget_id = v_budget.id and idem_key = p_idem_key and status in (''reserved'', ''committed'')
  ) then
    return jsonb_build_object(''status'', ''refused'', ''amount_usd'', 0, ''reason'', ''platform_unread'');
  end if;

  v_today := _ad_budget_today();');
  execute definition;
end $$;

create function public.record_ad_budget_partial_actual_v2(
  p_tenant_id uuid, p_budget_id uuid, p_actual_usd numeric, p_month date, p_failed_platforms text[])
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_failed_known numeric; v_prev jsonb; v_next jsonb;
begin
  if p_actual_usd is null or not (p_actual_usd >= 0 and p_actual_usd < 1000000000) then
    raise exception 'invalid partial actual';
  end if;
  if p_failed_platforms is null or cardinality(p_failed_platforms) = 0 then
    raise exception 'partial actual needs the failed platforms';
  end if;
  select coalesce(sum(amount_usd), 0) into v_failed_known from ad_spend_daily
   where tenant_id = p_tenant_id and platform = any(p_failed_platforms) and source = 'api'
     and spend_date >= p_month and spend_date < (p_month + interval '1 month')::date;
  select read_failed into v_prev from ad_budgets where id = p_budget_id and tenant_id = p_tenant_id;
  select coalesce(jsonb_object_agg(p, coalesce(v_prev->p, to_jsonb(now()))), '{}'::jsonb) into v_next
    from unnest(p_failed_platforms) as p;
  update ad_budgets set spent_usd = greatest(spent_usd, ceil((p_actual_usd + v_failed_known) * 100) / 100),
         read_failed = v_next, updated_at = now()
   where id = p_budget_id and tenant_id = p_tenant_id and status = 'active'
     and month_start = p_month and month_start = date_trunc('month', _ad_budget_today())::date;
  return record_ad_budget_actual(p_tenant_id, p_budget_id, null, p_month);
end $$;

create function public.clear_ad_budget_read_failed_platforms(p_tenant_id uuid, p_budget_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update ad_budgets set read_failed = '{}'::jsonb, updated_at = now()
   where id = p_budget_id and tenant_id = p_tenant_id and read_failed <> '{}'::jsonb;
end $$;

revoke all on function public.record_ad_budget_partial_actual_v2(uuid,uuid,numeric,date,text[]) from public,anon,authenticated;
revoke all on function public.clear_ad_budget_read_failed_platforms(uuid,uuid) from public,anon,authenticated;
grant execute on function public.record_ad_budget_partial_actual_v2(uuid,uuid,numeric,date,text[]) to service_role;
grant execute on function public.clear_ad_budget_read_failed_platforms(uuid,uuid) to service_role;

commit;
