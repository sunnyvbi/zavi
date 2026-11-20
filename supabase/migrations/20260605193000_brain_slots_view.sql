
create view brain_slots with (security_invoker = true) as
select
  mn.tenant_id,
  mn.slug,
  mn.body_markdown,
  mn.metadata
from memory_note mn
where mn.note_type = 'anchor'
  and mn.superseded_by is null
  and mn.slug is not null;

grant select on brain_slots to authenticated;

comment on view brain_slots is
  'Business Brain 10-slot — active anchor rows (tenant_id, slug, body_markdown, '
  'metadata) for the brain grid. security_invoker=true so memory_note RLS applies '
  'to the calling user (a plain view would bypass RLS = cross-tenant leak). The '
  '10-row grid shape is composed server-side from BRAIN_SLOT_SLUGS.';
