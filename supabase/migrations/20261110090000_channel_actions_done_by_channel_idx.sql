create index if not exists channel_actions_done_by_channel_idx
  on public.channel_actions (tenant_id, channel_slug, executed_at desc)
  where status = 'acted' and exec_status = 'executed';
