insert into custom_agent_reserved_names (name_norm) values
  ('ai ugc videos')
on conflict (name_norm) do nothing;
