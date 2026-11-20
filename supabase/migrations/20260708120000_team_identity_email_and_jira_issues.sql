

alter table team_member_identities
  add column if not exists recent_issue_keys text[],
  add column if not exists avatar_url text;

create or replace function list_team_members()
returns table (
  id uuid,
  display_name text,
  primary_email text,
  kind text,
  status text,
  identities jsonb,
  ambiguous_count int
)
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_is_admin boolean;
begin
  select active_tenant_id into v_tenant from profiles where user_id = auth.uid();
  if v_tenant is null then raise exception 'no active tenant' using errcode = '42501'; end if;
  if not exists (select 1 from tenant_users where tenant_id = v_tenant and user_id = auth.uid()) then
    raise exception 'not a member' using errcode = '42501';
  end if;

  select exists (
    select 1 from tenant_users
    where tenant_id = v_tenant and user_id = auth.uid()
      and role in ('owner','admin')
  ) into v_is_admin;

  return query
  select tm.id, tm.display_name, tm.primary_email, tm.kind, tm.status,
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'provider', i.provider,
             'external_id', i.external_id,
             'external_email', case when v_is_admin then i.external_email else null end,
             'external_display_name', i.external_display_name,
             'recent_issue_keys', i.recent_issue_keys,
             'avatar_url', i.avatar_url,
             'confidence', i.confidence,
             'source', i.source
           ) order by i.provider)
           from team_member_identities i
           where i.member_id = tm.id
         ), '[]'::jsonb),
         coalesce((
           select count(*)::int from team_member_identities i
           where i.member_id = tm.id and i.confidence < 1.00 and i.source = 'auto'
         ), 0)
    from team_members tm
    where tm.tenant_id = v_tenant and tm.status = 'active'
    order by tm.display_name;
end $$;

revoke all on function list_team_members() from public;
grant execute on function list_team_members() to authenticated;
