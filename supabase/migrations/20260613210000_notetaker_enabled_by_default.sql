
alter table tenant_meeting_settings
  alter column enabled set default true;

update tenant_meeting_settings
set enabled = true,
    updated_at = now()
where enabled = false
  and enabled_at is null
  and nullif(trim(meeting_url), '') is null;
