
create table if not exists public.channel_actions_copy_cleanup_backup_20261015 (
  id uuid not null,
  tenant_id uuid not null,
  fix text not null check (fix in ('how_to', 'geo_body')),
  title text,
  body jsonb,
  how_to jsonb,
  new_body jsonb,
  new_how_to jsonb,
  backed_up_at timestamptz not null default now(),
  primary key (id, fix)
);

alter table public.channel_actions_copy_cleanup_backup_20261015 enable row level security;
revoke all on table public.channel_actions_copy_cleanup_backup_20261015 from public, anon, authenticated;

with prev as (
  select c.id, c.tenant_id, c.title, c.body, c.how_to
  from public.channel_actions c
  where c.status in ('pending', 'snoozed')
    and jsonb_typeof(c.how_to) = 'array'
    and jsonb_array_length(c.how_to) > 0
    and (c.steps_done is null or c.steps_done in ('[]'::jsonb, '{}'::jsonb))
    and not exists (
      select 1 from jsonb_array_elements(c.how_to) e
      where not (
        jsonb_typeof(e) = 'string'
        and ((e #>> '{}') ~ '^Open .+ and make the change this card describes\.$'
          or (e #>> '{}') ~ '^Check that it worked, then press .+\.$')
      )
    )
),
upd as (
  update public.channel_actions c
     set how_to = '[]'::jsonb
    from prev
   where c.id = prev.id
     and c.status in ('pending', 'snoozed')
     and c.how_to = prev.how_to
  returning prev.id, prev.tenant_id, prev.title, prev.body, prev.how_to, c.how_to as new_how_to
)
insert into public.channel_actions_copy_cleanup_backup_20261015 (id, tenant_id, fix, title, body, how_to, new_body, new_how_to)
select id, tenant_id, 'how_to', title, body, how_to, null, new_how_to from upd
on conflict (id, fix) do nothing;

with prev as (
  select c.id, c.tenant_id, c.title, c.body, c.how_to
  from public.channel_actions c
  where c.status in ('pending', 'snoozed')
    and c.channel_slug = 'geo'
    and (strpos(c.body::text, 'Write the date. Tell us next week and we will pick the fix for the questions you were missing from.') > 0
      or strpos(c.body::text, 'Write the date. Tell us next week and we will pick the fix from the questions where you were missing.') > 0
      or strpos(c.body::text, 'Write the date. Tell us next week and we will pick the fix from the questions you were missing from.') > 0
      or strpos(c.body::text, 'Write the date. Tell us next week and we''ll pick the next fix from the questions you were missing from.') > 0)
),
upd as (
  update public.channel_actions c
     set body = replace(replace(replace(replace(c.body::text,
           'Write the date. Tell us next week and we will pick the fix for the questions you were missing from.',
           'Write the date and run it again in a month to see which answers changed.'),
           'Write the date. Tell us next week and we will pick the fix from the questions where you were missing.',
           'Write the date and run it again in a month to see which answers changed.'),
           'Write the date. Tell us next week and we will pick the fix from the questions you were missing from.',
           'Write the date and run it again in a month to see which answers changed.'),
           'Write the date. Tell us next week and we''ll pick the next fix from the questions you were missing from.',
           'Write the date and run it again in a month to see which answers changed.')::jsonb
    from prev
   where c.id = prev.id
     and c.status in ('pending', 'snoozed')
     and c.body = prev.body
  returning prev.id, prev.tenant_id, prev.title, prev.body, prev.how_to, c.body as new_body
)
insert into public.channel_actions_copy_cleanup_backup_20261015 (id, tenant_id, fix, title, body, how_to, new_body, new_how_to)
select id, tenant_id, 'geo_body', title, body, how_to, new_body, null from upd
on conflict (id, fix) do nothing;

