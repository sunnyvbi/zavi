
begin;

alter table public.extension_screenshots
  add column if not exists kind text not null default 'turn'
    check (kind in ('turn', 'task_step'));

alter table public.extension_screenshots
  add column if not exists run_id uuid;

comment on column public.extension_screenshots.kind is
  'turn = uploaded on Send (counts toward the 50/day cap); task_step = a saved step screenshot of a tab task (<=5 per run, not counted).';
comment on column public.extension_screenshots.run_id is
  'For task_step rows: the agent run of the tab task. Null for turn rows.';

commit;
