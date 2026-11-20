

alter table agent_feedback
  add column created_by_role text not null default 'operator'
    check (created_by_role in ('operator', 'staff'));

update agent_feedback set created_by_role = 'operator' where created_by_role is null;

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

create or replace function agent_feedback_summary_v2(
  p_tenant_id uuid,
  p_window_days int default 7
) returns table (
  agent_slug text,
  operator_thumbs_up int,
  operator_thumbs_down int,
  staff_thumbs_up int,
  staff_thumbs_down int,
  operator_total int,
  staff_total int,
  operator_nps numeric,
  staff_nps numeric,
  recent_negative_comments text[]
)
language sql stable as $$
  with rows as (
    select
      af.agent_slug,
      af.rating,
      af.comment,
      af.created_at,
      af.created_by_role
    from agent_feedback af
    where af.tenant_id = p_tenant_id
      and af.created_at >= now() - (p_window_days || ' days')::interval
  )
  select
    agent_slug,
    count(*) filter (where rating = 1 and created_by_role = 'operator')::int  as operator_thumbs_up,
    count(*) filter (where rating = -1 and created_by_role = 'operator')::int as operator_thumbs_down,
    count(*) filter (where rating = 1 and created_by_role = 'staff')::int     as staff_thumbs_up,
    count(*) filter (where rating = -1 and created_by_role = 'staff')::int    as staff_thumbs_down,
    count(*) filter (where created_by_role = 'operator')::int as operator_total,
    count(*) filter (where created_by_role = 'staff')::int as staff_total,
    case when count(*) filter (where created_by_role = 'operator') > 0
      then round(
        (count(*) filter (where rating = 1 and created_by_role = 'operator')::numeric -
         count(*) filter (where rating = -1 and created_by_role = 'operator')::numeric)
         / count(*) filter (where created_by_role = 'operator')::numeric, 3)
      else 0
    end as operator_nps,
    case when count(*) filter (where created_by_role = 'staff') > 0
      then round(
        (count(*) filter (where rating = 1 and created_by_role = 'staff')::numeric -
         count(*) filter (where rating = -1 and created_by_role = 'staff')::numeric)
         / count(*) filter (where created_by_role = 'staff')::numeric, 3)
      else 0
    end as staff_nps,
    array(
      select comment from rows r2
      where r2.agent_slug = rows.agent_slug
        and r2.rating = -1 and r2.comment is not null
      order by r2.created_at desc
      limit 3
    ) as recent_negative_comments
  from rows
  group by agent_slug;
$$;

revoke all on function agent_feedback_summary_v2(uuid, int) from public;
