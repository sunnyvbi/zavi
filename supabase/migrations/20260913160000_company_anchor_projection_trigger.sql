
begin;

create or replace function memory_note_company_is_a_projection()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.slug is distinct from 'company' then
    return new;
  end if;

  if coalesce(new.source, '') = 'agent_write'
     and coalesce(new.metadata ->> 'derived_from', '') = 'company_record' then
    if tg_op = 'INSERT' then
      return new;
    elsif new.metadata ->> 'rendered_at' is distinct from old.metadata ->> 'rendered_at' then
      return new;
    end if;
  end if;

  if tg_op = 'UPDATE'
     and old.superseded_by is null
     and new.superseded_by is not null
     and new.body_markdown is not distinct from old.body_markdown then
    return new;
  end if;

  raise warning 'memory_note slug=company is a projection — write DROPPED (source=%, derived_from=%). Write tenant_fact.company_story and let the brief render.',
    coalesce(new.source, '<null>'),
    coalesce(new.metadata ->> 'derived_from', '<null>');
  return null;
end $$;

drop trigger if exists memory_note_company_is_a_projection_trg on memory_note;
create trigger memory_note_company_is_a_projection_trg
  before insert or update on memory_note
  for each row
  execute function memory_note_company_is_a_projection();

revoke all on function memory_note_company_is_a_projection() from public, anon, authenticated;

commit;
