insert into custom_agent_reserved_names (name_norm) values
  ('influencers'),
  ('ugc videos')
on conflict (name_norm) do nothing;
