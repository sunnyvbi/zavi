
create or replace function submit_agent_feedback(
  p_target_type text,
  p_target_id uuid,
  p_rating smallint,
  p_comment text
) returns table (
  feedback_id uuid,
  agent_slug text,
  tenant_id uuid
)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_agent_slug text;
  v_clean_comment text;
  v_feedback_id uuid;
begin
  if v_user_id is null then
    raise exception 'unauthenticated';
  end if;

  if p_target_type not in ('agent_run', 'decision') then
    raise exception 'invalid target_type: %', p_target_type;
  end if;

  if p_target_type = 'agent_run' then
    select ar.tenant_id, ar.agent_slug
      into v_tenant_id, v_agent_slug
      from agent_runs ar
      where ar.id = p_target_id;
  elsif p_target_type = 'decision' then
    select d.tenant_id, ar.agent_slug
      into v_tenant_id, v_agent_slug
      from decisions d
      join agent_runs ar on ar.id = d.agent_run_id
      where d.id = p_target_id;
  end if;

  if v_tenant_id is null then
    raise exception 'target not found';
  end if;

  if v_agent_slug is null then
    raise exception 'agent_slug not derivable from target';
  end if;

  if not exists (
    select 1 from tenant_users tu
    where tu.tenant_id = v_tenant_id and tu.user_id = v_user_id
  ) then
    raise exception 'unauthorized';
  end if;

  v_clean_comment := nullif(btrim(regexp_replace(coalesce(p_comment, ''),
                            E'[\\u0000-\\u0008\\u000a-\\u001f\\u007f]', '', 'g')), '');
  if v_clean_comment is not null and length(v_clean_comment) > 500 then
    v_clean_comment := substring(v_clean_comment, 1, 500);
  end if;

  if p_rating is null and v_clean_comment is null then
    raise exception 'feedback must include rating or comment';
  end if;

  if p_rating is not null and p_rating not in (-1, 1) then
    raise exception 'rating must be -1 or 1';
  end if;

  insert into agent_feedback (
    tenant_id, target_type, target_id, agent_slug,
    rating, comment, created_by
  ) values (
    v_tenant_id, p_target_type, p_target_id, v_agent_slug,
    p_rating, v_clean_comment, v_user_id
  )
  on conflict (tenant_id, target_type, target_id, created_by)
    do update set
      rating = excluded.rating,
      comment = excluded.comment,
      created_at = now()
  returning agent_feedback.id into v_feedback_id;

  return query select v_feedback_id, v_agent_slug, v_tenant_id;
end $$;

revoke all on function submit_agent_feedback(text, uuid, smallint, text) from public;
grant execute on function submit_agent_feedback(text, uuid, smallint, text) to authenticated;

create or replace function submit_staff_feedback(
  p_staff_user_id uuid,
  p_target_type text,
  p_target_id uuid,
  p_rating smallint,
  p_comment text
) returns table (
  feedback_id uuid,
  agent_slug text,
  tenant_id uuid
)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_tenant_id uuid;
  v_agent_slug text;
  v_clean_comment text;
  v_feedback_id uuid;
begin
  if p_staff_user_id is null then
    raise exception 'staff_user_id required';
  end if;

  if p_target_type not in ('agent_run', 'decision') then
    raise exception 'invalid target_type: %', p_target_type;
  end if;

  if p_target_type = 'agent_run' then
    select ar.tenant_id, ar.agent_slug
      into v_tenant_id, v_agent_slug
      from agent_runs ar
      where ar.id = p_target_id;
  elsif p_target_type = 'decision' then
    select d.tenant_id, ar.agent_slug
      into v_tenant_id, v_agent_slug
      from decisions d
      join agent_runs ar on ar.id = d.agent_run_id
      where d.id = p_target_id;
  end if;

  if v_tenant_id is null then
    raise exception 'target not found';
  end if;

  if v_agent_slug is null then
    raise exception 'agent_slug not derivable from target';
  end if;

  v_clean_comment := nullif(btrim(regexp_replace(coalesce(p_comment, ''),
                            E'[\\u0000-\\u0008\\u000a-\\u001f\\u007f]', '', 'g')), '');
  if v_clean_comment is not null and length(v_clean_comment) > 500 then
    v_clean_comment := substring(v_clean_comment, 1, 500);
  end if;

  if p_rating is null and v_clean_comment is null then
    raise exception 'feedback must include rating or comment';
  end if;

  if p_rating is not null and p_rating not in (-1, 1) then
    raise exception 'rating must be -1 or 1';
  end if;

  insert into agent_feedback (
    tenant_id, target_type, target_id, agent_slug,
    rating, comment, created_by, created_by_role
  ) values (
    v_tenant_id, p_target_type, p_target_id, v_agent_slug,
    p_rating, v_clean_comment, p_staff_user_id, 'staff'
  )
  on conflict (tenant_id, target_type, target_id, created_by)
    do update set
      rating = excluded.rating,
      comment = excluded.comment,
      created_by_role = 'staff',
      created_at = now()
  returning agent_feedback.id into v_feedback_id;

  return query select v_feedback_id, v_agent_slug, v_tenant_id;
end $$;

revoke all on function submit_staff_feedback(uuid, text, uuid, smallint, text) from public;
