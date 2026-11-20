
begin;

alter table tenant_fact
  drop constraint if exists tenant_fact_value_text_check;

alter table tenant_fact
  add constraint tenant_fact_value_text_check
  check (
    length(btrim(value_text)) >= 1
    and length(btrim(value_text)) <= case key
      when 'company_story' then 8000
      when 'competitors' then 1300
      else 500
    end
  );

comment on column tenant_fact.value_text is
  'The fact. 1..500 chars, except competitors (1,300: 20 names x 60) and company_story '
  '(8,000: the narrative the brain company note is rendered from).';

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
    'company_story'
  ) then
    raise exception 'project_tenant_fact: % is not projectable (domain has its own validated writer)', p_key
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
  'research, AI estimates). Refuses to overwrite a higher-ranked source; returns false '
  'instead of raising so a refusal does not fail the publish that called it. Every key of '
  'THE company record is projectable except domain, which has one validated writer, '
  'set_tenant_company_domain_system. service_role only.';

commit;
