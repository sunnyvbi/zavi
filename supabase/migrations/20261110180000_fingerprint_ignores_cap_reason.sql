
create or replace function decision_content_fingerprint(p_body jsonb)
returns text
language sql
immutable
set search_path = public as $$
  select md5(
    coalesce(
      (
        coalesce(p_body, '{}'::jsonb)
          - 'source_run_id'
          - 'source_signals'
          - 'emitted_at'
          - 'confidence'
          - 'brain_citations'
          - 'decision_evidence'
          - 'cap_reason'
      )::text,
      ''
    )
  );
$$;
