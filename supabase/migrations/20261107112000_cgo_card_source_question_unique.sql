begin;
create unique index if not exists decisions_cgo_card_source_question
  on public.decisions (tenant_id, (body->>'source_question_id'))
  where decision_class = 'cgo.dispatch-specialist' and body ? 'source_question_id';
commit;
