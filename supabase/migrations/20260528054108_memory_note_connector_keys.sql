

alter table memory_note
  add column if not exists connector_object_keys jsonb not null default '[]'::jsonb;

comment on column memory_note.connector_object_keys is
  'Bundle A item A-4: jsonb array of "<connector_kind>:<object_id>" string keys '
  '(e.g. ["slack_channel:C123","stripe_customer:cus_X","github_repo:owner/name"]). '
  'Populated on write from the distill source / agent run connector context. '
  'memory_search_hybrid prefilters the candidate pool to notes sharing any of a '
  'caller-supplied key set via jsonb ?| BEFORE vector/keyword ranking. '
  'Default [] = untagged note, matches nothing in the prefilter.';

create index if not exists memory_note_connector_keys_gin
  on memory_note using gin (connector_object_keys);
