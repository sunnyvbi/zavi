alter table public.social_account_snapshots
  add column if not exists account_id text,
  add column if not exists connection_id text;
alter table public.social_post_metric_snapshots
  add column if not exists account_id text;

create or replace function public.store_instagram_snapshots(
  p_tenant_id uuid,
  p_connection_id text,
  p_account_id text,
  p_captured_at timestamptz,
  p_account jsonb,
  p_posts jsonb
) returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_connection text;
  v_day date := (p_captured_at at time zone 'UTC')::date;
begin
  if nullif(btrim(p_account_id), '') is null or p_captured_at is null
     or jsonb_typeof(p_account) is distinct from 'object'
     or jsonb_typeof(p_posts) is distinct from 'array' then
    raise exception 'invalid Instagram snapshot';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('instagram_snapshots:' || p_tenant_id::text, 0));
  select team_id into v_connection from public.connector_metadata
    where tenant_id = p_tenant_id and slug = 'composio.instagram' for share;
  if v_connection is null or v_connection is distinct from p_connection_id then
    return false;
  end if;
  if exists (select 1 from public.social_account_snapshots
    where tenant_id = p_tenant_id and channel = 'instagram'
      and created_at > p_captured_at) then
    return false;
  end if;

  update public.social_account_snapshots set account_id = p_account_id
    where tenant_id = p_tenant_id and channel = 'instagram' and account_id is null
      and nullif(lower(username), '') = nullif(lower(p_account->>'username'), '');
  update public.social_post_metric_snapshots p set account_id = p_account_id
    where p.tenant_id = p_tenant_id and p.channel = 'instagram' and p.account_id is null
      and exists (select 1 from jsonb_array_elements(p_posts) current_post
        where current_post->>'external_post_id' = p.external_post_id)
      and exists (select 1 from public.social_account_snapshots a
        where a.tenant_id = p.tenant_id and a.channel = p.channel
          and a.captured_on = p.captured_on and a.account_id = p_account_id);
  delete from public.social_post_metric_snapshots
    where tenant_id = p_tenant_id and channel = 'instagram'
      and (account_id is distinct from p_account_id or captured_on = v_day);
  delete from public.social_account_snapshots
    where tenant_id = p_tenant_id and channel = 'instagram'
      and account_id is distinct from p_account_id;

  insert into public.social_account_snapshots (
    tenant_id, channel, captured_on, account_id, connection_id, created_at,
    username, name, profile_image_url, followers_count, post_count
  ) values (
    p_tenant_id, 'instagram', v_day, p_account_id, p_connection_id, p_captured_at,
    p_account->>'username', p_account->>'name', p_account->>'profile_image_url',
    (p_account->>'followers_count')::int, (p_account->>'post_count')::int
  ) on conflict (tenant_id, channel, captured_on) do update set
    account_id = excluded.account_id, connection_id = excluded.connection_id,
    created_at = excluded.created_at, username = excluded.username,
    name = excluded.name, profile_image_url = excluded.profile_image_url,
    followers_count = excluded.followers_count, post_count = excluded.post_count;

  insert into public.social_post_metric_snapshots (
    tenant_id, channel, captured_on, account_id, external_post_id,
    posted_at, text, url, format, has_link, metrics
  ) select p_tenant_id, 'instagram', v_day, p_account_id, p->>'external_post_id',
      (p->>'posted_at')::timestamptz, p->>'text', p->>'url', p->>'format',
      (p->>'has_link')::boolean, p->'metrics'
    from jsonb_array_elements(p_posts) p;
  return true;
end;
$$;

revoke all on function public.store_instagram_snapshots(uuid,text,text,timestamptz,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.store_instagram_snapshots(uuid,text,text,timestamptz,jsonb,jsonb)
  to service_role;
