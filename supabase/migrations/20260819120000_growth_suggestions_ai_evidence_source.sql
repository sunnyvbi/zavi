
begin;

alter table public.growth_suggestions
  drop constraint if exists growth_suggestions_source_check;

alter table public.growth_suggestions
  add constraint growth_suggestions_source_check
  check (source in ('ai_evidence', 'ai_ads', 'manual', 'paste'));

update public.growth_suggestions
   set source = 'ai_evidence'
 where source = 'ai_ads';

commit;
