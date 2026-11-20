begin;

alter table public.agent_feedback
  add column if not exists build_reasons text[];

alter table public.agent_feedback
  drop constraint if exists agent_feedback_build_reasons_check;

alter table public.agent_feedback
  add constraint agent_feedback_build_reasons_check
  check (
    build_reasons is null
    or (
      cardinality(build_reasons) <= 6
      and build_reasons <@ array['look', 'layout', 'copy', 'missing', 'broken', 'slow']::text[]
    )
  );

commit;
