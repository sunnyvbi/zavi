
alter table meeting_bots
  add column source text not null default 'scheduled'
    check (source in ('scheduled','adhoc')),
  add column requested_by uuid references auth.users(id),
  add column summary_email_sent_at timestamptz;

alter table meeting_bots drop constraint if exists meeting_bots_tenant_id_scheduled_date_key;
create unique index if not exists meeting_bots_scheduled_daily_uniq
  on meeting_bots (tenant_id, scheduled_date)
  where source = 'scheduled';

create index if not exists meeting_bots_adhoc_active_idx
  on meeting_bots (tenant_id, meeting_url)
  where source = 'adhoc' and status in ('scheduled','joining','in_call');
