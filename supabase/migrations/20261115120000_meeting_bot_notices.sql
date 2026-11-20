alter table public.meeting_bots
  add column if not exists waiting_notice_at timestamptz,
  add column if not exists failed_notice_at timestamptz;
