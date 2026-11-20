
create table onboarding_draft (
  user_id uuid primary key references auth.users(id) on delete cascade,
  wizard jsonb not null default '{}'::jsonb,
  chat_history jsonb not null default '[]'::jsonb,
  quiz_questions jsonb not null default '[]'::jsonb,
  quiz_answers jsonb not null default '{}'::jsonb,
  generated_memory jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table onboarding_draft enable row level security;

create policy onboarding_draft_self_select on onboarding_draft
  for select using (user_id = auth.uid());

create policy onboarding_draft_self_insert on onboarding_draft
  for insert with check (user_id = auth.uid());

create policy onboarding_draft_self_update on onboarding_draft
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy onboarding_draft_self_delete on onboarding_draft
  for delete using (user_id = auth.uid());

create index onboarding_draft_updated_at_idx
  on onboarding_draft (updated_at);
