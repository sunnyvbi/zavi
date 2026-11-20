
set lock_timeout = '5s';

alter table email_threads
  drop constraint if exists email_threads_tenant_id_id_key;
alter table email_threads
  add constraint email_threads_tenant_id_id_key unique (tenant_id, id);

alter table agent_threads
  add column if not exists email_thread_id uuid;

alter table agent_threads
  drop constraint if exists agent_threads_email_thread_fk;
alter table agent_threads
  add constraint agent_threads_email_thread_fk
  foreign key (tenant_id, email_thread_id)
  references email_threads (tenant_id, id)
  on delete set null (email_thread_id);

comment on column agent_threads.email_thread_id is
  'The email conversation this chat mirrors (set only by the email reply mirror). NULL = an ordinary app chat.';

create unique index if not exists agent_threads_email_thread_uniq
  on agent_threads (tenant_id, user_id, agent_slug, email_thread_id)
  where email_thread_id is not null and deleted_at is null;
