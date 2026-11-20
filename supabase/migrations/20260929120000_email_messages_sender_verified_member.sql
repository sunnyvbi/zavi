alter table public.email_messages
  add column if not exists sender_verified_member boolean not null default false;

create or replace function public.member_user_id_by_email(p_tenant_id uuid, p_email text)
returns uuid
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select tu.user_id
  from tenant_users tu
  join auth.users u on u.id = tu.user_id
  where tu.tenant_id = p_tenant_id
    and tu.role <> 'viewer'
    and coalesce(btrim(p_email), '') <> ''
    and lower(u.email) = lower(btrim(p_email))
  order by tu.created_at asc
  limit 1;
$$;
revoke all on function public.member_user_id_by_email(uuid, text) from public, anon, authenticated;
grant execute on function public.member_user_id_by_email(uuid, text) to service_role;
