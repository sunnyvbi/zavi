
create table dream_candidates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  new_note_id uuid not null,
  existing_note_id uuid not null,
  verdict text not null check (verdict in ('KEEP_NEW', 'KEEP_OLD', 'MERGE')),
  rationale text,
  merged_body text,
  note_type text,
  source_ref text,
  label text not null default 'pending' check (label in ('pending', 'approved', 'rejected')),
  decision_reason text,
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  cost_tokens int,
  created_at timestamptz not null default now()
);

create unique index dream_candidates_pending_uq
  on dream_candidates (tenant_id, new_note_id, existing_note_id)
  where label = 'pending';

create index dream_candidates_by_tenant_label
  on dream_candidates (tenant_id, label, created_at desc);

alter table dream_candidates enable row level security;

create policy dream_candidates_member_select on dream_candidates
  for select using (
    exists (select 1 from tenant_users tu
              where tu.user_id = auth.uid()
                and tu.tenant_id = dream_candidates.tenant_id)
  );
