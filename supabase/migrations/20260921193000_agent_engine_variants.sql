
create table if not exists agent_engine_variants (
  slug        text primary key
              check (slug ~ '^[a-z0-9][a-z0-9_-]{0,39}$' and slug <> 'default'),
  label       text not null check (length(btrim(label)) > 0),
  config      jsonb not null default '{}'::jsonb
              check (jsonb_typeof(config) = 'object'),
  note        text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

create table if not exists tenant_agent_variant_assignments (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  agent_slug   text not null check (length(btrim(agent_slug)) > 0),
  variant_slug text not null references agent_engine_variants(slug) on delete cascade,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id),
  primary key (tenant_id, agent_slug)
);

alter table agent_engine_variants enable row level security;
alter table tenant_agent_variant_assignments enable row level security;

revoke all on agent_engine_variants from public, authenticated, anon;
revoke all on tenant_agent_variant_assignments from public, authenticated, anon;
grant all on agent_engine_variants to service_role;
grant all on tenant_agent_variant_assignments to service_role;

alter table public.agent_runs add column if not exists engine_variant text;

comment on column public.agent_runs.engine_variant is
  'Slug of the agent_engine_variants row applied to this run; NULL means the default engine settings.';

insert into agent_engine_variants (slug, label, config, note) values
  ('v1', 'V1 — lean prompt + low effort',
   '{"effort":"low","isolate_settings":true,"prompt":{"skills":["operator-render-video","operator-slack-document"]}}',
   'The candidate: ~30% faster and ~25% cheaper on 2 questions. Quality unproven — run the 100-case eval before widening.'),
  ('v1-prompt', 'V1 half — lean prompt only',
   '{"isolate_settings":true,"prompt":{"skills":["operator-render-video","operator-slack-document"]}}',
   'Isolates the prompt move (cost win, no latency win). Compare with v1 to attribute a change to effort.'),
  ('v1-medium', 'V1 fallback — lean prompt + medium effort',
   '{"effort":"medium","isolate_settings":true,"prompt":{"skills":["operator-render-video","operator-slack-document"]}}',
   'Fallback if low loses quality on the eval: half the speed-up, less behaviour change.')
on conflict (slug) do nothing;

insert into agent_engine_variants (slug, label, config, note) values
  ('v2', 'V2 — V1 plus hot tools kept out of tool search',
   '{"effort":"low","isolate_settings":true,"prompt":{"skills":["operator-render-video","operator-slack-document"]},"tools":{"always_load":["praxis__handoff","operator_db__catalog","operator_db__query","memory__search","praxis_corpus__query_recent_runs","web_search__search"]}}',
   'The v2 candidate. Assign AFTER v1 has an eval result, so a regression is attributable to the tool change.'),
  ('v2-tools', 'V2 half — hot tools only, default prompt and effort',
   '{"tools":{"always_load":["praxis__handoff","operator_db__catalog","operator_db__query","memory__search","praxis_corpus__query_recent_runs","web_search__search"]}}',
   'Isolates the tool change against default. The safest single step: it removes a round trip without changing prompt or effort.')
on conflict (slug) do nothing;
