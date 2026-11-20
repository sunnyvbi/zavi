create or replace function public._email_result_finalize(p_result_id uuid, p_old_d7 jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r         email_send_results%rowtype;
  v_open    int;
  v_d7      jsonb;
  v_held    boolean;
  v_verdict text;
  v_changed boolean;
  v_ga_only boolean;
  v_ga_keys text[] := array['visitors', 'ga_status', 'ga_as_of'];
begin
  select * into r from email_send_results where id = p_result_id;
  if r.id is null then return; end if;
  v_held := coalesce(r.win_line->>'metric' = 'visitors', false)
    and r.win_line->>'basis' is distinct from 'first_sends'
    and exists (select 1 from email_result_tasks
                 where result_id = r.id and source = 'ga' and stage = 'd7' and state in ('pending', 'waiting'));
  if r.d7_published_at is null then
    select count(*) into v_open from email_result_tasks
     where result_id = r.id and source = 'provider' and stage = 'd7' and state in ('pending', 'waiting');
    if v_open = 0 then
      v_d7 := public._email_result_carry(r.h1, r.d7);
      update email_send_results
         set d7 = v_d7, d7_published_at = now(),
             verdict = case when v_held then null else public._email_result_verdict(win_line, v_d7) end,
             d7_told_at = case when v_held then now() else d7_told_at end,
             d7_version = d7_version + 1, updated_at = now()
       where id = r.id;
    end if;
    return;
  end if;
  v_verdict := case when v_held then null else public._email_result_verdict(r.win_line, r.d7) end;
  v_changed := r.d7 is distinct from p_old_d7;
  v_ga_only := (r.d7 - v_ga_keys) is not distinct from (coalesce(p_old_d7, '{}'::jsonb) - v_ga_keys)
    and r.d7->>'ga_status' is distinct from 'shared_tag';
  if v_verdict is distinct from r.verdict or (v_changed and not v_ga_only) then
    update email_send_results
       set verdict = v_verdict, d7_version = d7_version + 1,
           d7_told_at = case when v_held then coalesce(d7_told_at, now()) else null end,
           updated_at = now()
     where id = r.id;
  elsif v_changed then
    insert into email_learn_work (tenant_id, kind, dedupe_key, due_at)
    values (r.tenant_id, 'result', 'result:' || r.id::text || ':' || r.d7_version::text || ':ga:' || coalesce(r.d7->>'ga_status', ''), now() + interval '10 minutes')
    on conflict (tenant_id, dedupe_key) do nothing;
  end if;
end $$;
revoke all on function public._email_result_finalize(uuid, jsonb) from public, anon, authenticated;
