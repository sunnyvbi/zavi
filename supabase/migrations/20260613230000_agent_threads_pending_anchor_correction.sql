
ALTER TABLE public.agent_threads
  ADD COLUMN IF NOT EXISTS pending_anchor_correction jsonb;

COMMENT ON COLUMN public.agent_threads.pending_anchor_correction IS
  'Staged anchor-correction draft awaiting operator chat confirmation (brain__refine_anchor → brain__apply_anchor). Server-authoritative preview body; nullable; cleared on apply/abort/stale.';
