
alter type tenant_fact_key add value if not exists 'company_name';
alter type tenant_fact_key add value if not exists 'markets';
alter type tenant_fact_key add value if not exists 'company_goals';

comment on type tenant_fact_key is
  'Closed key set for the resident company fact sheet. LIVE keys (app layer): domain, '
  'what_we_sell, who_we_serve, competitors, company_name, markets, company_goals. '
  'signup_url + pricing_page are VESTIGIAL as of 2026-07-16 — retained only because '
  'Postgres cannot drop an enum value. Do not re-add them to the app.';
