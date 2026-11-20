
begin;

set lock_timeout = '5s';

alter table public.tenant_rule_settings
  add column if not exists ad_guard jsonb not null default '{}'::jsonb;

create or replace function public._ad_guard_place_ok(p jsonb)
returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select jsonb_typeof(p) = 'object'
    and jsonb_typeof(p->'id') = 'string' and length(p->>'id') between 1 and 64
    and jsonb_typeof(p->'name') = 'string' and length(p->>'name') between 1 and 200
    and p->>'kind' in ('Country', 'State', 'City', 'Zip', 'Region', 'Other')
    and p->>'platform' in ('meta', 'google')
$$;

create or replace function public.rule_set_ad_guard(p_tenant_id uuid, p_actor uuid, p_guard jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_allowed jsonb := coalesce(p_guard->'allowed_places', '[]'::jsonb);
  v_blocked jsonb := coalesce(p_guard->'blocked_places', '[]'::jsonb);
  v_phrases jsonb := coalesce(p_guard->'banned_phrases', '[]'::jsonb);
  v_clean   jsonb;
begin
  perform _rules_assert_manager(p_tenant_id, p_actor);
  if jsonb_typeof(v_allowed) <> 'array' or jsonb_typeof(v_blocked) <> 'array' or jsonb_typeof(v_phrases) <> 'array'
     or jsonb_array_length(v_allowed) > 50 or jsonb_array_length(v_blocked) > 50 or jsonb_array_length(v_phrases) > 50 then
    raise exception 'rules: up to 50 places in each list and 50 phrases' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_allowed || v_blocked) e where not coalesce(_ad_guard_place_ok(e), false)) then
    raise exception 'rules: a place could not be read; search for it again' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_phrases) e
    where jsonb_typeof(e) <> 'string' or length(btrim(e #>> '{}')) not between 1 and 80
  ) then
    raise exception 'rules: a phrase needs 1 to 80 characters' using errcode = '22023';
  end if;
  v_clean := jsonb_build_object(
    'allowed_places', (select coalesce(jsonb_agg(jsonb_build_object('id', e->>'id', 'name', e->>'name', 'kind', e->>'kind', 'platform', e->>'platform') order by n), '[]'::jsonb) from jsonb_array_elements(v_allowed) with ordinality as x(e, n)),
    'blocked_places', (select coalesce(jsonb_agg(jsonb_build_object('id', e->>'id', 'name', e->>'name', 'kind', e->>'kind', 'platform', e->>'platform') order by n), '[]'::jsonb) from jsonb_array_elements(v_blocked) with ordinality as x(e, n)),
    'banned_phrases', (select coalesce(jsonb_agg(p order by n), '[]'::jsonb) from (select btrim(e #>> '{}') as p, min(n) as n from jsonb_array_elements(v_phrases) with ordinality as x(e, n) group by 1) d)
  );
  insert into tenant_rule_settings (tenant_id, ad_guard, updated_by, updated_at)
  values (p_tenant_id, v_clean, p_actor, now())
  on conflict (tenant_id) do update
    set ad_guard = excluded.ad_guard, updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('status', 'ok', 'ad_guard', v_clean);
end $$;
revoke all on function public.rule_set_ad_guard(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.rule_set_ad_guard(uuid, uuid, jsonb) to service_role;
revoke all on function public._ad_guard_place_ok(jsonb) from public, anon, authenticated;

commit;
