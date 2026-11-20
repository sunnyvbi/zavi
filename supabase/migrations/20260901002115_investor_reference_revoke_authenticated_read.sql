
drop policy if exists investor_reference_read on public.investor_reference;

alter table public.investor_reference enable row level security;

comment on table public.investor_reference is
  'Curated investor reference list (contains email/linkedin/bio PII). RLS default-deny: service-role only, read via apps/backend/src/services/tools/investor-db/search.ts. Do NOT add a `to authenticated using (true)` policy — see migration S1 investor_reference_revoke_authenticated_read.';
