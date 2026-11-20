alter table public.meeting_bots drop constraint if exists meeting_bots_status_check;
alter table public.meeting_bots add constraint meeting_bots_status_check check (status in (
  'scheduled','joining','in_call','call_ended','processing','ingested','failed','cancelled'
));
