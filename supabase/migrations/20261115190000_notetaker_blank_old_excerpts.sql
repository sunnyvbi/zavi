
begin;

create or replace function public.notetaker_blank_old_excerpts()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
  set statement_timeout = '30s' set lock_timeout = '5s' as $$
declare
  v_facts integer;
  v_cards integer;
begin
  with doomed as (
    select a.id from public.meeting_atoms a
     where a.created_at < now() - interval '30 days'
       and a.source_excerpt <> ''
     order by a.created_at
     limit 1000
     for update skip locked
  )
  update public.meeting_atoms a set source_excerpt = '' from doomed where a.id = doomed.id;
  get diagnostics v_facts = row_count;

  with doomed as (
    select d.id from public.decisions d
     where d.decision_class = 'notetaker.write_atoms'
       and d.emitted_at < now() - interval '30 days'
       and jsonb_typeof(d.body) = 'object'
       and not (d.body ? 'excerpts_cleared_at')
     order by d.emitted_at
     limit 200
     for update skip locked
  )
  update public.decisions d
     set body = case
                  when jsonb_typeof(d.body -> 'atoms') = 'array' then
                    jsonb_set(d.body, '{atoms}', coalesce((
                      select jsonb_agg(
                               case when jsonb_typeof(e.v) = 'object' and e.v ? 'source_excerpt'
                                    then e.v || jsonb_build_object('source_excerpt', '')
                                    else e.v end
                               order by e.ord)
                        from jsonb_array_elements(d.body -> 'atoms') with ordinality as e(v, ord)
                    ), '[]'::jsonb))
                  else d.body
                end || jsonb_build_object('excerpts_cleared_at', now())
    from doomed
   where d.id = doomed.id;
  get diagnostics v_cards = row_count;

  return jsonb_build_object('facts', v_facts, 'cards', v_cards);
end $$;

revoke all on function public.notetaker_blank_old_excerpts() from public, anon, authenticated;
grant execute on function public.notetaker_blank_old_excerpts() to service_role;

commit;
