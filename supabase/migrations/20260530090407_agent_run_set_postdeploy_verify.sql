
create or replace function agent_run_set_postdeploy_verify(
  p_run_id uuid,
  p_tenant_id uuid,
  p_verify jsonb
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_verdict text;
  v_error text;
  v_count int;
begin
  if p_verify is null or jsonb_typeof(p_verify) <> 'object' then
    raise exception 'agent_run_set_postdeploy_verify: p_verify must be a JSON object';
  end if;
  v_verdict := p_verify->>'verdict';
  if v_verdict is null then
    raise exception 'agent_run_set_postdeploy_verify: p_verify.verdict required';
  end if;

  if v_verdict = 'success' then
    v_error := null;
  else
    v_error := v_verdict
            || coalesce(': '   || nullif(p_verify->>'status_code', ''), '')
            || coalesce(' '    || nullif(p_verify->>'snippet', ''), '');
  end if;

  update agent_runs
     set parsed = coalesce(parsed, '{}'::jsonb)
                  || jsonb_build_object('postdeploy_verify', p_verify),
         parse_ok = case when v_verdict = 'success' then parse_ok else false end,
         error    = case when v_verdict = 'success' then error    else v_error end
   where id = p_run_id
     and tenant_id = p_tenant_id;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function agent_run_set_postdeploy_verify(uuid, uuid, jsonb) from public;
grant execute on function agent_run_set_postdeploy_verify(uuid, uuid, jsonb) to service_role;
