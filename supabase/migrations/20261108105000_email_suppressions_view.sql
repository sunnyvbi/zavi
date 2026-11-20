alter table public.email_suppression enable row level security;
drop policy if exists email_suppression_select on public.email_suppression;
revoke all on public.email_suppression from public, anon, authenticated;
grant select, insert, update, delete on public.email_suppression to service_role;

create or replace function public.list_email_suppressions(p_tenant_id uuid, p_user_id uuid, p_search text default null, p_page int default 1)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_role text;
  v_masked boolean;
  v_size constant int := 50;
  v_page int := least(greatest(coalesce(p_page, 1), 1), 10000);
  v_q text := nullif(btrim(left(coalesce(p_search, ''), 200)), '');
  v_like text;
  v_total int;
  v_rows jsonb;
begin
  if p_tenant_id is null or p_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  select tu.role into v_role from tenant_users tu where tu.tenant_id = p_tenant_id and tu.user_id = p_user_id limit 1;
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  v_masked := v_role not in ('owner', 'admin');
  if v_q is not null then
    v_like := '%' || replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  select count(*) into v_total
    from email_suppression s
   where s.tenant_id = p_tenant_id
     and (v_like is null or (case when v_masked then split_part(s.email, '@', 2) else s.email end) like v_like escape '\');

  select coalesce(jsonb_agg(jsonb_build_object(
           'email', case when v_masked then left(x.email, 1) || '***@' || split_part(x.email, '@', 2) else x.email end,
           'reason', x.reason,
           'created_at', x.created_at
         ) order by x.created_at desc, x.email), '[]'::jsonb)
    into v_rows
    from (
      select s.email, s.reason, s.created_at
        from email_suppression s
       where s.tenant_id = p_tenant_id
         and (v_like is null or (case when v_masked then split_part(s.email, '@', 2) else s.email end) like v_like escape '\')
       order by s.created_at desc, s.email
       limit v_size offset (v_page - 1) * v_size
    ) x;

  return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page, 'page_size', v_size, 'masked', v_masked);
end $$;
revoke all on function public.list_email_suppressions(uuid, uuid, text, int) from public, anon, authenticated;
grant execute on function public.list_email_suppressions(uuid, uuid, text, int) to service_role;

create or replace function public.add_email_suppression(p_tenant_id uuid, p_user_id uuid, p_email text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role text;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_reason text;
  v_created timestamptz;
begin
  if p_tenant_id is null or p_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  select tu.role into v_role from tenant_users tu where tu.tenant_id = p_tenant_id and tu.user_id = p_user_id limit 1;
  if v_role is null or v_role not in ('owner', 'admin') then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  if length(v_email) > 320 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('ok', false, 'code', 'bad_email');
  end if;

  insert into email_suppression (tenant_id, email, reason)
  values (p_tenant_id, v_email, 'manual')
  on conflict (tenant_id, email) do nothing
  returning created_at into v_created;

  if v_created is not null then
    return jsonb_build_object('ok', true, 'added', true, 'email', v_email, 'reason', 'manual', 'created_at', v_created);
  end if;
  select s.reason, s.created_at into v_reason, v_created from email_suppression s where s.tenant_id = p_tenant_id and s.email = v_email;
  return jsonb_build_object('ok', true, 'added', false, 'email', v_email, 'reason', v_reason, 'created_at', v_created);
end $$;
revoke all on function public.add_email_suppression(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.add_email_suppression(uuid, uuid, text) to service_role;
