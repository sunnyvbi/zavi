begin;

create or replace function public.submit_build_feedback(
  p_target_id uuid,
  p_rating smallint,
  p_comment text,
  p_build_reasons text[]
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
  v_clean_comment text;
  v_feedback_id uuid;
  v_build_reasons text[] := case
    when p_rating = -1 then coalesce(p_build_reasons, array[]::text[])
    else array[]::text[]
  end;
begin
  if v_user_id is null then
    raise exception 'unauthenticated';
  end if;

  select c.tenant_id
    into v_tenant_id
    from public.conductor_runs c
    where c.id = p_target_id
      and c.kind = 'build_app'
      and exists (
        select 1 from public.tenant_users tu
        where tu.tenant_id = c.tenant_id and tu.user_id = v_user_id
      );

  if v_tenant_id is null then
    raise exception 'target not found';
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

  if cardinality(v_build_reasons) > 6 or exists (
    select 1
    from unnest(v_build_reasons) reason
    where reason is null or reason not in ('look', 'layout', 'copy', 'missing', 'broken', 'slow')
  ) then
    raise exception 'invalid build reasons';
  end if;

  insert into public.agent_feedback (
    tenant_id, target_type, target_id, agent_slug,
    rating, comment, build_reasons, created_by
  ) values (
    v_tenant_id, 'conductor_run', p_target_id, 'engineer',
    p_rating, v_clean_comment, v_build_reasons, v_user_id
  )
  on conflict (tenant_id, target_type, target_id, created_by)
    where target_id is not null
    do update set
      rating = excluded.rating,
      comment = excluded.comment,
      build_reasons = excluded.build_reasons,
      created_at = now()
  returning agent_feedback.id into v_feedback_id;

  return query select v_feedback_id, 'engineer'::text, v_tenant_id;
end $$;

revoke all on function public.submit_build_feedback(uuid, smallint, text, text[]) from public, anon, authenticated;
grant execute on function public.submit_build_feedback(uuid, smallint, text, text[]) to authenticated;

commit;
