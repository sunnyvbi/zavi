
alter table public.thread_event
  drop constraint if exists thread_event_kind_check;

alter table public.thread_event
  add constraint thread_event_kind_check
  check (kind in (
    'chat_user',
    'chat_assistant',
    'run_start',
    'reasoning',
    'plan',
    'tool_call',
    'file_read',
    'file_edit',
    'file_create',
    'decision',
    'run_end'
  ));
