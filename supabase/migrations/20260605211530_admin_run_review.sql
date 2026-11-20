
create table if not exists agent_run_review (
  id                  bigint      generated always as identity primary key,
  run_id              uuid        not null,
  tenant_id           uuid        not null,
  agent_slug          text        not null,
  staff_user_id       uuid        not null,
  staff_email         text,
  verdict             text        not null
                      check (verdict in ('score_correct', 'score_wrong', 'bug')),
  ai_score_at_review  smallint,
  quality_model       text,
  comment             text,
  regression_signature text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (run_id, staff_user_id)
);

create index if not exists agent_run_review_calib_idx
  on agent_run_review (quality_model, agent_slug, verdict);
create index if not exists agent_run_review_run_idx
  on agent_run_review (run_id);

alter table agent_run_review enable row level security;

create or replace function record_agent_run_review(
  p_run_id        uuid,
  p_staff_user_id uuid,
  p_staff_email   text,
  p_verdict       text,
  p_comment       text default null,
  p_regression_signature text default null
) returns table (review_id bigint, out_tenant_id uuid, out_agent_slug text)
language plpgsql security definer set search_path = public as $$
declare
  v_tenant     uuid;
  v_slug       text;
  v_score      smallint;
  v_model      text;
  v_review_id  bigint;
begin
  if p_run_id is null then
    raise exception 'record_agent_run_review: null run_id' using errcode = '22023';
  end if;
  if p_staff_user_id is null then
    raise exception 'record_agent_run_review: null staff_user_id' using errcode = '22023';
  end if;
  if p_verdict is null or p_verdict not in ('score_correct', 'score_wrong', 'bug') then
    raise exception 'record_agent_run_review: bad verdict %', p_verdict using errcode = '22023';
  end if;

  select tenant_id, agent_slug, quality_score, quality_model
    into v_tenant, v_slug, v_score, v_model
    from agent_runs where id = p_run_id;
  if v_tenant is null then
    raise exception 'record_agent_run_review: run % not found', p_run_id using errcode = '22023';
  end if;

  insert into agent_run_review (
    run_id, tenant_id, agent_slug, staff_user_id, staff_email,
    verdict, ai_score_at_review, quality_model, comment, regression_signature
  ) values (
    p_run_id, v_tenant, v_slug, p_staff_user_id, left(coalesce(p_staff_email, ''), 320),
    p_verdict, v_score, v_model, left(coalesce(p_comment, ''), 2000),
    p_regression_signature
  )
  on conflict (run_id, staff_user_id) do update
    set verdict              = excluded.verdict,
        ai_score_at_review   = excluded.ai_score_at_review,
        quality_model        = excluded.quality_model,
        comment              = excluded.comment,
        regression_signature = coalesce(excluded.regression_signature, agent_run_review.regression_signature),
        updated_at           = now()
  returning id into v_review_id;

  return query select v_review_id, v_tenant, v_slug;
end $$;
revoke all on function record_agent_run_review(uuid, uuid, text, text, text, text) from public;
revoke all on function record_agent_run_review(uuid, uuid, text, text, text, text) from authenticated;
grant execute on function record_agent_run_review(uuid, uuid, text, text, text, text) to service_role;

create or replace function list_judge_calibration(
  p_min_labels int default 1
) returns table (
  out_quality_model text,
  out_agent_slug    text,
  correct           bigint,
  wrong             bigint,
  total             bigint,
  accuracy_pct      numeric
)
language sql security definer set search_path = public as $$
  select
    coalesce(quality_model, 'unknown')                              as out_quality_model,
    agent_slug                                                      as out_agent_slug,
    count(*) filter (where verdict = 'score_correct')               as correct,
    count(*) filter (where verdict = 'score_wrong')                 as wrong,
    count(*) filter (where verdict in ('score_correct','score_wrong')) as total,
    round(
      100.0 * count(*) filter (where verdict = 'score_correct')
      / nullif(count(*) filter (where verdict in ('score_correct','score_wrong')), 0),
      1
    )                                                               as accuracy_pct
  from agent_run_review
  where verdict in ('score_correct', 'score_wrong')
  group by coalesce(quality_model, 'unknown'), agent_slug
  having count(*) filter (where verdict in ('score_correct','score_wrong')) >= greatest(p_min_labels, 1)
  order by total desc, agent_slug;
$$;
revoke all on function list_judge_calibration(int) from public;
revoke all on function list_judge_calibration(int) from authenticated;
grant execute on function list_judge_calibration(int) to service_role;
