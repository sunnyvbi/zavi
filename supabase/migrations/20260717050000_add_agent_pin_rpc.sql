
create or replace function add_agent_pin(p_slug text, p_tenant_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_slug is null or length(p_slug) < 1 or length(p_slug) > 128 then
    raise exception 'p_slug must be a 1-128 char string' using errcode = '22023';
  end if;

  v_tenant_id := coalesce(p_tenant_id, app_active_tenant());
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id
  ) then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  insert into workspace_agent_pins (user_id, tenant_id, pinned_slugs, updated_at)
  values (v_user_id, v_tenant_id, jsonb_build_array(p_slug), now())
  on conflict (user_id, tenant_id) do update
    set pinned_slugs = case
          when workspace_agent_pins.pinned_slugs @> jsonb_build_array(p_slug)
            then workspace_agent_pins.pinned_slugs
          when jsonb_array_length(workspace_agent_pins.pinned_slugs) >= 30
            then workspace_agent_pins.pinned_slugs
          else workspace_agent_pins.pinned_slugs || jsonb_build_array(p_slug)
        end,
        updated_at = case
          when workspace_agent_pins.pinned_slugs @> jsonb_build_array(p_slug)
            then workspace_agent_pins.updated_at
          when jsonb_array_length(workspace_agent_pins.pinned_slugs) >= 30
            then workspace_agent_pins.updated_at
          else now()
        end;
end;
$$;

revoke all on function add_agent_pin(text, uuid) from public;
grant execute on function add_agent_pin(text, uuid) to authenticated;

comment on function add_agent_pin(text, uuid) is
  'Atomically + idempotently appends ONE agent slug to the calling user''s sidebar Main-tab pins for p_tenant_id (default: their active tenant). Powers agent stickiness: chatting with an agent pins it. No-op when already pinned or at the 30 cap. Membership always re-checked.';
