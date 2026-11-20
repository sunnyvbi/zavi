
begin;

alter table agent_threads
  add column if not exists title_source text not null default 'message';

commit;
