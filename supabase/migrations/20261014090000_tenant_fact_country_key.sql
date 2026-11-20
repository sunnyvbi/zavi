
alter type tenant_fact_key add value if not exists 'country';

comment on type tenant_fact_key is
  'Closed key set for THE company record (services/company/facts.ts). LIVE keys: domain, '
  'what_we_sell, who_we_serve, competitors, company_name, markets, industry, location, '
  'founded, linkedin_url, instagram_url, facebook_url, x_url, company_story, country '
  '(ISO 3166-1 alpha-2, 20261014090000). Vestigial: signup_url, pricing_page, company_goals.';
