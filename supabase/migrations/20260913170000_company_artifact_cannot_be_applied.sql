
begin;

create or replace function extracted_artifact_company_is_a_projection()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.kind = 'memory_update'
     and new.target_slug = 'company'
     and new.status = 'applied'
     and old.status is distinct from 'applied' then
    raise exception 'the company brief is generated from the company record and cannot be applied as a note — write tenant_fact.company_story instead (artifact %)', new.id
      using errcode = '22023';
  end if;
  return new;
end $$;

drop trigger if exists extracted_artifact_company_is_a_projection_trg on extracted_artifacts;
create trigger extracted_artifact_company_is_a_projection_trg
  before update on extracted_artifacts
  for each row
  execute function extracted_artifact_company_is_a_projection();

revoke all on function extracted_artifact_company_is_a_projection() from public, anon, authenticated;

commit;
