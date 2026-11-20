
begin;

alter table code_index_state add column if not exists last_status     text;
alter table code_index_state add column if not exists last_error      text;
alter table code_index_state add column if not exists last_attempt_at timestamptz;

create or replace function code_index_record_status(
  p_tenant_id uuid,
  p_repo      text,
  p_status    text,
  p_error     text
) returns void
language plpgsql security definer set search_path = public set statement_timeout = '30s' as $$
begin
  if p_tenant_id is null or p_repo is null then
    raise exception 'code_index_record_status: tenant_id and repo are required'
      using errcode = '22023';
  end if;

  insert into code_index_state (tenant_id, repo_full_name, last_status, last_error, last_attempt_at)
  values (p_tenant_id, p_repo, p_status, left(p_error, 500), now())
  on conflict (tenant_id, repo_full_name) do update
    set last_status     = excluded.last_status,
        last_error      = excluded.last_error,
        last_attempt_at = excluded.last_attempt_at;
end $$;

revoke all on function code_index_record_status(uuid, text, text, text) from public;
grant execute on function code_index_record_status(uuid, text, text, text) to service_role;

commit;
