
create unique index if not exists connector_metadata_slack_team_id_uniq
  on connector_metadata (team_id)
  where slug = 'slack' and team_id is not null;
