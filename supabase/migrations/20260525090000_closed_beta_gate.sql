
alter table public.profiles
  add column if not exists beta_invited_at timestamptz;

update public.profiles
   set beta_invited_at = now()
 where beta_invited_at is null;
