
create or replace function social_publish_finalize(
  p_post_id text,
  p_ok boolean,
  p_external_post_id text,
  p_external_url text,
  p_error text,
  p_response jsonb
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uuid uuid := p_post_id::uuid;
begin
  update social_publish_attempts
     set status = case when p_ok then 'succeeded' else 'failed' end,
         response = p_response, error = p_error
   where post_id = v_uuid
     and (p_ok or status <> 'succeeded');
  update social_posts
     set status = case when p_ok then 'published' else 'failed' end,
         external_post_id = coalesce(p_external_post_id, external_post_id),
         external_url = coalesce(p_external_url, external_url),
         last_error = case when p_ok then null else p_error end,
         updated_at = now()
   where id = v_uuid
     and (p_ok or status <> 'published');
end $$;

revoke all on function social_publish_finalize(text, boolean, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function social_publish_finalize(text, boolean, text, text, text, jsonb) to service_role;
