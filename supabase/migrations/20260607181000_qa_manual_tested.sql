
begin;

alter table public.test_cases
  add column if not exists manual_tested_at timestamptz;

create or replace function public.qa_set_test_case_tested(
  p_case_id  uuid,
  p_tested   boolean
) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_tenant_id uuid;
  v_new       timestamptz;
begin
  if p_case_id is null then
    raise exception 'qa_set_test_case_tested: case_id required'
      using errcode = '22023';
  end if;

  select tc.tenant_id
    into v_tenant_id
    from public.test_cases tc
    where tc.id = p_case_id
      and exists (
        select 1 from public.tenant_users tu
        where tu.user_id = auth.uid()
          and tu.tenant_id = tc.tenant_id
      );

  if v_tenant_id is null then
    raise exception 'qa_set_test_case_tested: case not found in your tenant'
      using errcode = 'P0002';
  end if;

  v_new := case when p_tested then now() else null end;

  update public.test_cases
    set manual_tested_at = v_new,
        updated_at = now()
    where id = p_case_id
      and tenant_id = v_tenant_id;

  return v_new;
end $$;

revoke all on function public.qa_set_test_case_tested(uuid, boolean) from public;
grant execute on function public.qa_set_test_case_tested(uuid, boolean) to authenticated;

commit;
