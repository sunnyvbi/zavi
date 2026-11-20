
begin;

create table public.email_templates (
  tenant_id      uuid primary key references public.tenants(id) on delete cascade,
  logo_url       text check (logo_url is null or (logo_url ~ '^https://' and length(logo_url) <= 2048)),
  brand_color    text not null check (brand_color ~* '^#[0-9a-f]{6}$'),
  button_color   text not null check (button_color ~* '^#[0-9a-f]{6}$'),
  font_key       text not null check (font_key ~ '^[a-z_]{1,32}$'),
  sign_off       text not null default '' check (length(sign_off) <= 300),
  postal_address text check (postal_address is null or length(postal_address) <= 500),
  show_cards     boolean not null default false,
  updated_by     uuid,
  updated_at     timestamptz not null default now()
);

alter table public.email_templates enable row level security;
revoke all on public.email_templates from anon, authenticated;
grant all on public.email_templates to service_role;

commit;
