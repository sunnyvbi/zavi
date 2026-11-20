
alter table human_member_pii
  add column if not exists age_years smallint
    check (age_years is null or age_years between 18 and 120),
  add column if not exists age_confirmed_at timestamptz;
