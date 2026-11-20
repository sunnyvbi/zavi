begin;

create unique index if not exists channel_actions_one_open_reddit_authorize
  on public.channel_actions (tenant_id, (exec_payload->>'ad_account_id'))
  where exec_class = 'reddit_ads.authorize_account' and status in ('pending', 'snoozed');

commit;
