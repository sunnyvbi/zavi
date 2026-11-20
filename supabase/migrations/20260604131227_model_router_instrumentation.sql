
alter table public.agent_runs
  add column if not exists model_used text,
  add column if not exists input_tokens int,
  add column if not exists output_tokens int,
  add column if not exists cache_read_tokens int,
  add column if not exists cache_creation_tokens int,
  add column if not exists routing_decision jsonb;

comment on column public.agent_runs.model_used is
  'The model the run ACTUALLY executed on. May differ from the agent''s declared metadata_praxis.model when the model router is live (cost-first Sonnet/Opus routing). NULL = pre-instrumentation row or router did not touch this run. Written by persistTerminal.';
comment on column public.agent_runs.input_tokens is
  'Fresh (non-cached) input tokens for this run (from NormalizedUsage). Disjoint from cache_read_tokens.';
comment on column public.agent_runs.output_tokens is
  'Output tokens for this run (from NormalizedUsage).';
comment on column public.agent_runs.cache_read_tokens is
  'Prompt-cache READ tokens (billed ~0.1x input). High share here is why a token-heavy run can still be cheap.';
comment on column public.agent_runs.cache_creation_tokens is
  'Prompt-cache WRITE tokens (billed ~1.25x input).';
comment on column public.agent_runs.routing_decision is
  'Model-router decision: {tier, reason_code, classifier_ms, shadow}. reason_code is a CONTROLLED enum string (flag_off/no_policy/thread_sticky/floor_payload_stage/floor_keyword/classifier_low/classifier_high/classifier_uncertain_opus/classifier_error_opus/policy_base) — NEVER raw user text (whitelist-safe, mirrors agent_run_events.meta discipline). NULL = router did not run (flag off or agent has no model_routing policy).';

alter table public.agent_threads
  add column if not exists routed_model text;

comment on column public.agent_threads.routed_model is
  'Thread-sticky model chosen by the router on turn 1. Reused on later (resume) turns because the SDK session is model-bound. NULL = never routed (router off, no policy, or non-routed agent).';
