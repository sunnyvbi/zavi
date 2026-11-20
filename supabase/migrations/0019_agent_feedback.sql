

create table agent_feedback (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  target_type text not null check (target_type in ('agent_run', 'decision')),
  target_id uuid not null,
  agent_slug text not null,
  rating smallint check (rating in (-1, 1)),
  comment text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create index agent_feedback_tenant_agent_idx
  on agent_feedback (tenant_id, agent_slug, created_at desc);

create index agent_feedback_target_idx
  on agent_feedback (target_type, target_id);

create unique index agent_feedback_unique_per_user_target
  on agent_feedback (tenant_id, target_type, target_id, created_by);

alter table agent_feedback enable row level security;

create policy agent_feedback_select on agent_feedback for select to authenticated using (
  tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
);

revoke insert, update, delete on agent_feedback from authenticated, anon;

create table improvement_attempt (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  target_agent_slug text not null,
  auditor_run_id uuid not null references agent_runs(id) on delete cascade,
  cto_run_id uuid references agent_runs(id) on delete set null,
  decision_id uuid references decisions(id) on delete set null,
  pr_repo text,
  pr_number int,
  pr_head_branch text,
  pr_merged_at timestamptz,
  resulting_tenant_agent_version int,
  pre_revision_nps numeric,
  post_revision_nps numeric,
  outcome text not null default 'pending'
    check (outcome in ('pending', 'accepted', 'rejected', 'unapproved', 'insufficient_signal')),
  lesson text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index improvement_attempt_tenant_slug_idx
  on improvement_attempt (tenant_id, target_agent_slug, created_at desc);

create index improvement_attempt_outcome_idx
  on improvement_attempt (tenant_id, outcome, created_at desc);

alter table improvement_attempt enable row level security;

create policy improvement_attempt_select on improvement_attempt for select to authenticated using (
  tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
);

revoke insert, update, delete on improvement_attempt from authenticated, anon;

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

revoke all on function agent_feedback_summary(uuid, int) from public;
