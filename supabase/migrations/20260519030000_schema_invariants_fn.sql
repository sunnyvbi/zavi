
create or replace function public.schema_invariants_ok()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    exists (
      select 1
      from pg_constraint
      where conname = 'memory_note_note_type_check'
        and pg_get_constraintdef(oid) like '%growth_lever_signal%'
    )
    and (
      select count(*) = 3
      from decision_classes
      where slug in (
        'growth-orchestrator.reallocate-budget',
        'growth-orchestrator.lifecycle-draft',
        'growth-orchestrator.social-draft'
      )
    );
$$;

grant execute on function public.schema_invariants_ok() to service_role;
