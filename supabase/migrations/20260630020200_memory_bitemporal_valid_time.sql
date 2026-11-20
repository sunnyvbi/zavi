
alter table memory_note add column if not exists valid_from timestamptz;
alter table memory_note add column if not exists valid_to   timestamptz;

comment on column memory_note.valid_from is
  'Bi-temporal VALID-TIME: instant the fact began to hold in the real world. NULL = unbounded/unknown (valid for all time on the lower side). Distinct from created_at (system time). Stamped only when memory_valid_time_enabled is ON for the tenant and a real-world date is extractable; never guessed.';
comment on column memory_note.valid_to is
  'Bi-temporal VALID-TIME: instant the fact stopped holding (exclusive upper bound). NULL = still holds / unknown. Set to a superseding note''s valid_from when an interval is closed on supersede. DISTINCT from superseded_at (system time of the record replacement).';

create index if not exists memory_note_valid_time_idx
  on memory_note (tenant_id, valid_from, valid_to)
  where superseded_by is null;
