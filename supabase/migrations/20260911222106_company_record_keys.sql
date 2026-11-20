
alter type tenant_fact_key add value if not exists 'industry';
alter type tenant_fact_key add value if not exists 'location';
alter type tenant_fact_key add value if not exists 'founded';
alter type tenant_fact_key add value if not exists 'linkedin_url';
alter type tenant_fact_key add value if not exists 'instagram_url';
alter type tenant_fact_key add value if not exists 'facebook_url';
alter type tenant_fact_key add value if not exists 'x_url';
alter type tenant_fact_key add value if not exists 'company_story';

comment on type tenant_fact_key is
  'Closed key set for THE company record (services/company/facts.ts). LIVE keys: domain, '
  'what_we_sell, who_we_serve, competitors, company_name, markets, company_goals, industry, '
  'location, founded, linkedin_url, instagram_url, facebook_url, x_url, company_story. '
  'signup_url + pricing_page are VESTIGIAL as of 2026-07-16 — retained only because Postgres '
  'cannot drop an enum value. Do not re-add them to the app.';
