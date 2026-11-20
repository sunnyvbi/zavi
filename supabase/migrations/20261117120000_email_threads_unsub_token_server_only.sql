alter table public.email_unsub_token enable row level security;
drop policy if exists email_unsub_token_select on public.email_unsub_token;
revoke all on public.email_unsub_token from public, anon, authenticated;
grant select, insert, update, delete on public.email_unsub_token to service_role;

alter table public.email_threads enable row level security;
drop policy if exists email_threads_member_select on public.email_threads;
revoke all on public.email_threads from public, anon, authenticated;
grant select, insert, update, delete on public.email_threads to service_role;

alter table public.email_messages enable row level security;
drop policy if exists email_messages_member_select on public.email_messages;
revoke all on public.email_messages from public, anon, authenticated;
grant select, insert, update, delete on public.email_messages to service_role;
