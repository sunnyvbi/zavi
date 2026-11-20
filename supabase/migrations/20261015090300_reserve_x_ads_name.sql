insert into custom_agent_reserved_names (name_norm) values
  ('x ads')
on conflict (name_norm) do nothing;
