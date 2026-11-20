
begin;

alter table packs
  add constraint packs_seed_memory_excludes_company
  check (not (seed_memory ? 'company'));

comment on constraint packs_seed_memory_excludes_company on packs is
  'The `company` anchor is a projection of the company record (memory_note trigger '
  'memory_note_company_is_a_projection). A pack seeding it would be silently dropped and '
  'still counted as inserted by activate_tenant_pack. Write tenant_fact.company_story instead.';

commit;
