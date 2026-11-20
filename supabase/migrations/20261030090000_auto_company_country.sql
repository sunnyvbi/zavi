
begin;

alter table connector_metadata
  add column if not exists account_geo jsonb;

alter table connector_metadata
  drop constraint if exists connector_metadata_account_geo_check;
alter table connector_metadata
  add constraint connector_metadata_account_geo_check
  check (
    account_geo is null
    or (
      jsonb_typeof(account_geo) = 'object'
      and coalesce(jsonb_typeof(account_geo->'countries'), 'array') = 'array'
      and coalesce(jsonb_typeof(account_geo->'timezones'), 'array') = 'array'
      and coalesce(jsonb_typeof(account_geo->'subjects'), 'null') in ('null', 'array')
    )
  );

comment on column connector_metadata.account_geo is
  'What this connected account says about where the business is: {for, countries (ISO alpha-2), '
  'timezones (IANA names), subjects (TikTok advertiser ids or null), checked_at}. Written only by set_connector_account_geo; read by the company '
  'country inference (services/company/country-inference.ts). Never an address.';

create or replace function set_connector_account_geo(
  p_tenant_id uuid,
  p_slug      text,
  p_for       text,
  p_countries text[],
  p_timezones text[],
  p_subjects  text[] default null
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_zone    text;
  v_country text;
  v_n       int;
begin
  if p_tenant_id is null or p_slug is null then
    raise exception 'set_connector_account_geo: tenant and slug are required' using errcode = '22023';
  end if;
  if coalesce(array_length(p_countries, 1), 0) > 20 or coalesce(array_length(p_subjects, 1), 0) > 200 then
    raise exception 'set_connector_account_geo: too many countries or subjects' using errcode = '22023';
  end if;
  foreach v_country in array coalesce(p_countries, array[]::text[]) loop
    if v_country !~ '^[A-Z]{2}$' then
      raise exception 'set_connector_account_geo: country must be an ISO alpha-2 code' using errcode = '22023';
    end if;
  end loop;
  if coalesce(array_length(p_timezones, 1), 0) > 20 then
    raise exception 'set_connector_account_geo: at most 20 time zones' using errcode = '22023';
  end if;
  foreach v_zone in array coalesce(p_timezones, array[]::text[]) loop
    if v_zone !~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2}$' then
      raise exception 'set_connector_account_geo: % is not a time zone name', v_zone using errcode = '22023';
    end if;
  end loop;

  update connector_metadata
     set account_geo = jsonb_build_object(
           'for', p_for,
           'countries', to_jsonb(coalesce(p_countries, array[]::text[])),
           'timezones', to_jsonb(coalesce(p_timezones, array[]::text[])),
           'subjects', to_jsonb(p_subjects),
           'checked_at', now()
         )
   where tenant_id = p_tenant_id
     and slug = p_slug
     and team_id is not distinct from p_for;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

revoke all on function set_connector_account_geo(uuid, text, text, text[], text[], text[]) from public, anon, authenticated;
grant execute on function set_connector_account_geo(uuid, text, text, text[], text[], text[]) to service_role;

create or replace function project_tenant_fact(
  p_tenant_id  uuid,
  p_key        tenant_fact_key,
  p_value_text text,
  p_source     tenant_fact_source,
  p_source_ref text default null
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prev            text;
  v_existing_source tenant_fact_source;
  v_written         int;
begin
  if p_tenant_id is null then
    raise exception 'tenant_id required' using errcode = '22023';
  end if;

  if p_key not in (
    'what_we_sell', 'who_we_serve', 'competitors', 'markets', 'company_name',
    'industry', 'location', 'founded',
    'linkedin_url', 'instagram_url', 'facebook_url', 'x_url',
    'company_story', 'country'
  ) then
    raise exception 'project_tenant_fact: % is not projectable (domain has its own validated writer)', p_key
      using errcode = '22023';
  end if;

  if p_key = 'country' and p_source <> 'connector' then
    raise exception 'project_tenant_fact: country is projectable only from connected accounts (source connector), not %', p_source
      using errcode = '22023';
  end if;

  if p_value_text is null or btrim(p_value_text) = '' then
    return false;
  end if;

  if fact_source_rank(p_source) is null then
    raise exception 'project_tenant_fact: source % has no rank — add it to fact_source_rank', p_source
      using errcode = '22023';
  end if;

  select value_text, source into v_prev, v_existing_source
    from tenant_fact where tenant_id = p_tenant_id and key = p_key;

  if v_existing_source is not null and fact_source_rank(v_existing_source) is null then
    raise exception 'project_tenant_fact: incumbent source % has no rank — add it to fact_source_rank', v_existing_source
      using errcode = '22023';
  end if;

  if p_key = 'country' and v_existing_source is not null then
    raise notice 'project_tenant_fact: country already set for tenant %, % write refused', p_tenant_id, p_source;
    return false;
  end if;

  if v_existing_source is not null
     and fact_source_rank(v_existing_source) > fact_source_rank(p_source) then
    raise notice 'project_tenant_fact: refusing % write over % for tenant % key %',
      p_source, v_existing_source, p_tenant_id, p_key;
    return false;
  end if;

  insert into tenant_fact (tenant_id, key, value_text, source, source_ref, verified_at, updated_at)
  values (p_tenant_id, p_key, btrim(p_value_text), p_source, p_source_ref, now(), now())
  on conflict (tenant_id, key) do update
    set value_text  = excluded.value_text,
        source      = excluded.source,
        source_ref  = excluded.source_ref,
        verified_at = now(),
        updated_at  = now()
    where fact_source_rank(tenant_fact.source) <= fact_source_rank(excluded.source)
      and excluded.key <> 'country'
  returning 1 into v_written;

  if v_written is null then
    raise notice 'project_tenant_fact: lost race, % refused over % for tenant % key %',
      p_source, v_existing_source, p_tenant_id, p_key;
    return false;
  end if;

  insert into tenant_config_audit (tenant_id, actor_user_id, action, target, prev_value, next_value)
  values (p_tenant_id, null, 'set-system-projected', 'tenant_fact.' || p_key::text,
          v_prev, btrim(p_value_text));

  return true;
end $$;

revoke execute on function project_tenant_fact(uuid, tenant_fact_key, text, tenant_fact_source, text)
  from public, anon, authenticated;
grant execute on function project_tenant_fact(uuid, tenant_fact_key, text, tenant_fact_source, text)
  to service_role;

comment on function project_tenant_fact is
  'Guarded write path for MACHINE-ORIGIN tenant_fact values (onboarding research, staff '
  'research, AI estimates, connected accounts). Refuses to overwrite a higher-ranked source; '
  'returns false instead of raising so a refusal does not fail the publish that called it. Every '
  'key of THE company record is projectable except domain, which has one validated writer, '
  'set_tenant_company_domain_system. country is projectable only from source connector '
  '(20261030090000). service_role only.';

comment on type tenant_fact_key is
  'Closed key set for THE company record (services/company/facts.ts). LIVE keys: domain, '
  'what_we_sell, who_we_serve, competitors, company_name, markets, industry, location, '
  'founded, linkedin_url, instagram_url, facebook_url, x_url, company_story, country '
  '(ISO 3166-1 alpha-2, 20261014090000: never a guess; a sourced inference with agreeing '
  'connected-account signals is allowed, source connector, and shown with its source, '
  '20261030090000). Vestigial: signup_url, pricing_page, company_goals.';

commit;
