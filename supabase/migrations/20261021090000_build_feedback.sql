
begin;

alter table agent_feedback drop constraint agent_feedback_target_type_check;
alter table agent_feedback add constraint agent_feedback_target_type_check
  check (
    target_type is null
    or target_type in ('agent_run', 'decision', 'conductor_run')
  );

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
language plpgsql security definer set search_path = public, pg_temp as $$
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

  if p_target_type not in ('agent_run', 'decision', 'conductor_run') then
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
  elsif p_target_type = 'conductor_run' then
    select c.tenant_id, 'engineer'
      into v_tenant_id, v_agent_slug
      from public.conductor_runs c
      where c.id = p_target_id
        and c.kind = 'build_app'
        and exists (
          select 1 from public.tenant_users tu
          where tu.tenant_id = c.tenant_id and tu.user_id = v_user_id
        );
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
    where target_id is not null
    do update set
      rating = excluded.rating,
      comment = excluded.comment,
      created_at = now()
  returning agent_feedback.id into v_feedback_id;

  return query select v_feedback_id, v_agent_slug, v_tenant_id;
end $$;

revoke all on function submit_agent_feedback(text, uuid, smallint, text) from public, anon, authenticated;
grant execute on function submit_agent_feedback(text, uuid, smallint, text) to authenticated;

create or replace function agent_feedback_summary(
  p_tenant_id uuid,
  p_window_days int default 7
) returns table (
  agent_slug text,
  thumbs_up int,
  thumbs_down int,
  total int,
  nps numeric,
  recent_negative_comments text[]
)
language sql stable as $$
  with rows as (
    select
      af.agent_slug,
      af.rating,
      af.comment,
      af.created_at
    from agent_feedback af
    where af.tenant_id = p_tenant_id
      and af.created_at >= now() - (p_window_days || ' days')::interval
      and af.target_type is distinct from 'conductor_run'
  )
  select
    agent_slug,
    count(*) filter (where rating = 1)::int  as thumbs_up,
    count(*) filter (where rating = -1)::int as thumbs_down,
    count(*)::int as total,
    case when count(*) > 0
      then round(
        (count(*) filter (where rating = 1)::numeric -
         count(*) filter (where rating = -1)::numeric)
         / count(*)::numeric, 3)
      else 0
    end as nps,
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

revoke all on function agent_feedback_summary(uuid, int) from public, anon, authenticated;

create or replace view public.home_suggestions with (security_invoker = true) as
select
  af.id as feedback_id,
  af.tenant_id,
  af.target_type,
  af.target_id,
  af.agent_slug,
  af.comment as suggestion_text,
  af.created_at,
  af.created_by
from agent_feedback af
where
  af.comment is not null
  and length(af.comment) > 0
  and af.target_type is distinct from 'conductor_run'
  and not exists (
    select 1 from improvement_attempt ia
    where ia.target_agent_slug = af.agent_slug
      and ia.tenant_id = af.tenant_id
      and ia.outcome = 'accepted'
      and ia.created_at > af.created_at
  )
order by af.created_at desc;

commit;
