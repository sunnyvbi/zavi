
create or replace function is_tenant_member_email(p_tenant_id uuid, p_email text)
returns boolean
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select exists (
    select 1
    from tenant_users tu
    join auth.users u on u.id = tu.user_id
    where tu.tenant_id = p_tenant_id
      and coalesce(btrim(p_email), '') <> ''
      and lower(u.email) = lower(btrim(p_email))
  );
$$;

revoke all on function is_tenant_member_email(uuid, text) from public;
revoke all on function is_tenant_member_email(uuid, text) from authenticated, anon;
grant execute on function is_tenant_member_email(uuid, text) to service_role;

comment on function is_tenant_member_email(uuid, text) is
  'AgentMail inbound gate: may this sender ask Zavi anything? Membership by email via tenant_users. The CALLER must ALSO verify DKIM/DMARC -- a From header alone is trivially spoofable, so this function by itself is NOT an authentication boundary.';

create or replace function tenant_member_emails(p_tenant_id uuid)
returns setof text
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select lower(u.email)
  from tenant_users tu
  join auth.users u on u.id = tu.user_id
  where tu.tenant_id = p_tenant_id
    and u.email is not null;
$$;

revoke all on function tenant_member_emails(uuid) from public;
revoke all on function tenant_member_emails(uuid) from authenticated, anon;
grant execute on function tenant_member_emails(uuid) to service_role;

comment on function tenant_member_emails(uuid) is
  'AgentMail outbound gate: the ONLY addresses an agent reply may be delivered to. The reply-all audience is intersected with this set, so CC-ing Zavi onto a thread that has a customer on it can never deliver the answer to the customer.';
