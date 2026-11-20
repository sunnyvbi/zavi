alter table agent_threads add column if not exists repo_full_name text;

comment on column agent_threads.repo_full_name is
  'Sticky target repo (owner/name) for this engineer chat thread. Set by chat-send on repo resolution; re-validated against connector_metadata.repo_full_names on read. NULL = use tenant default.';
