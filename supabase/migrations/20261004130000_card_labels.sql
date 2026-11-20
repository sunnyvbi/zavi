
set lock_timeout = '5s';

create table if not exists public.card_label_batch (
  id          uuid primary key default gen_random_uuid(),
  created_by  uuid not null,
  slots       smallint not null default 2 check (slots between 1 and 10),
  created_at  timestamptz not null default now()
);

create table if not exists public.card_label_item (
  batch_id   uuid not null references public.card_label_batch(id) on delete cascade,
  position   integer not null check (position >= 0),
  action_id  uuid not null references public.channel_actions(id) on delete cascade,
  overlap    boolean not null default false,
  snapshot   jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  primary key (batch_id, position),
  unique (batch_id, action_id)
);

create table if not exists public.card_label_labeller (
  batch_id   uuid not null references public.card_label_batch(id) on delete cascade,
  user_id    uuid not null,
  slot       smallint not null check (slot >= 0),
  joined_at  timestamptz not null default now(),
  primary key (batch_id, user_id),
  unique (batch_id, slot)
);

create table if not exists public.card_label (
  batch_id    uuid not null references public.card_label_batch(id) on delete cascade,
  action_id   uuid not null references public.channel_actions(id) on delete cascade,
  labeller    uuid not null,
  answers     jsonb not null check (jsonb_typeof(answers) = 'object'),
  note        text check (note is null or length(note) <= 1000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (batch_id, action_id, labeller)
);

comment on table public.card_label is
  'Human labels on channel action cards. answers = {TRUE|WORTH_NOW|RIGHT_GOAL|STEPS_FOLLOWABLE: yes|no|skip}. Scored against the Codex judges by scripts/channel-cards-judge.mjs.';

do $$
declare t text;
begin
  foreach t in array array['card_label_batch', 'card_label_item', 'card_label_labeller', 'card_label'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;
