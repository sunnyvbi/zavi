
alter type tenant_fact_key add value if not exists 'competitors';

comment on type tenant_fact_key is
  'Closed key set for the resident company fact sheet. LIVE keys (app layer): domain, '
  'what_we_sell, who_we_serve, competitors. signup_url + pricing_page are VESTIGIAL as of '
  '2026-07-16 — cut from the product, retained here only because Postgres cannot drop an '
  'enum value and the type is embedded in the set_tenant_fact signature. They have no '
  'writer (FACT_KEYS) and no renderer (KEY_ORDER). Do not re-add them to the app.';
