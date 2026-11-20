
set lock_timeout = '5s';

alter table public.card_label_item
  add column if not exists technical boolean not null default false;

comment on column public.card_label_item.technical is
  'In the technical reviewer queue (TRUE + RIGHT_GOAL). The quick queue (WORTH_NOW + STEPS_FOLLOWABLE) covers every item.';
comment on column public.card_label_item.overlap is
  'Pilot card: among the first cards every quick labeller sees, used to check the question wording.';
