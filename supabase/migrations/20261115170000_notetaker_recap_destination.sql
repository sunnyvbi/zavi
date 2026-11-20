
begin;

alter table public.tenant_meeting_settings
  add column if not exists recap_destination text,
  add column if not exists choose_destination_email_at timestamptz;

update public.tenant_meeting_settings s
   set recap_destination = 'slack'
  from public.tenants t
 where t.id = s.tenant_id
   and t.slug = 'upcar-ai'
   and s.slack_channel_id is not null
   and s.recap_destination is null;

update public.tenant_meeting_settings
   set slack_channel_id = null,
       slack_channel_name = null
 where recap_destination is null
   and slack_channel_id is not null;

alter table public.tenant_meeting_settings drop constraint if exists tenant_meeting_settings_recap_destination_check;
alter table public.tenant_meeting_settings add constraint tenant_meeting_settings_recap_destination_check
  check (recap_destination is null or recap_destination in ('slack', 'email', 'off'));

alter table public.tenant_meeting_settings drop constraint if exists tenant_meeting_settings_recap_slack_channel_check;
alter table public.tenant_meeting_settings add constraint tenant_meeting_settings_recap_slack_channel_check
  check (recap_destination is distinct from 'slack' or slack_channel_id is not null);

create table if not exists public.meeting_notes (
  bot_id uuid primary key references public.meeting_bots(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  minutes jsonb,
  transcript text not null default '',
  created_at timestamptz not null default now(),
  delete_after timestamptz not null default (now() + interval '30 days'),
  constraint meeting_notes_kept_30_days_check check (delete_after <= created_at + interval '30 days')
);

alter table public.meeting_notes enable row level security;
revoke all on table public.meeting_notes from public, anon, authenticated;
grant select on table public.meeting_notes to authenticated;

drop policy if exists meeting_notes_member_select on public.meeting_notes;
create policy meeting_notes_member_select on public.meeting_notes
  for select to authenticated using (
    delete_after > now()
    and exists (select 1 from public.tenant_users tu where tu.user_id = auth.uid() and tu.tenant_id = meeting_notes.tenant_id)
  );
drop policy if exists meeting_notes_active_tenant_restrict on public.meeting_notes;
create policy meeting_notes_active_tenant_restrict on public.meeting_notes
  as restrictive for select using (tenant_id = (select public.app_active_tenant()));

alter table public.tenant_meeting_settings alter column consent_message set default
  'Zavi Notetaker is recording and transcribing this meeting to brief your AI team. Important decisions and blockers are saved; the recording itself is deleted after transcription. A summary is shared with your team after the call. Ask the host to disable Zavi in workspace settings to opt out.';

update public.tenant_meeting_settings
   set consent_message = 'Zavi Notetaker is recording and transcribing this meeting to brief your AI team. Important decisions and blockers are saved; the recording itself is deleted after transcription. A summary is shared with your team after the call. Ask the host to disable Zavi in workspace settings to opt out.'
 where consent_message = 'Zavi Notetaker is recording and transcribing this meeting to brief your AI team. Important decisions and blockers are saved; the recording itself is deleted after transcription. Ask the host to disable Zavi in workspace settings to opt out.';

commit;
