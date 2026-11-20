
insert into app_setting (key, value, value_type, description)
values
  ('memory_recall_floor', '0'::jsonb, 'number',
   'Min rerank relevance score (0..1) for a hit to be injected as recall context (rerank path only). 0 = no floor.'),
  ('memory_index_kind', '"none"'::jsonb, 'string',
   'ANN index strategy for memory_chunk embedding search: none | ivfflat | hnsw.')
on conflict (key) do nothing;
