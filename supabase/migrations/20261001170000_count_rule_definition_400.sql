
begin;

alter table autopilot_goals drop constraint if exists autopilot_goals_count_rule_shape;
alter table autopilot_goals add constraint autopilot_goals_count_rule_shape check (
  count_rule is null or (
    jsonb_typeof(count_rule) = 'object'
    and count_rule ->> 'dialect' in ('sql', 'mongodb')
    and count_rule ->> 'source' = 'operator_db'
    and char_length(coalesce(count_rule ->> 'definition', '')) between 1 and 400
    and pg_column_size(count_rule) <= 16384
  )
);

do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.cgo_questions'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%char_length(ask)%'
  loop
    execute format('alter table public.cgo_questions drop constraint %I', c.conname);
  end loop;
end $$;
alter table cgo_questions add constraint cgo_questions_ask_length check (char_length(ask) between 1 and 800);

commit;
