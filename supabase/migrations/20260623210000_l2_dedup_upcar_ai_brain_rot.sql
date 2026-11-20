
update memory_note
set superseded_by = '86264d23-0853-46ba-bd31-994b685e134f',
    superseded_at = now(),
    supersession_rationale = 'L2 dedup 2026-06-23: duplicate of canonical driver-approval note 86264d23 (credit 400 + TLO + MVR/SambaSafety + 2pts/2yr). No info lost.'
where tenant_id = '73db45ff-457e-4541-bc8f-bdb625390204'
  and id in (
    'ad045320-fa2b-43a4-b347-0ea62fb2583a',
    '14be50d0-97cd-4652-9348-f4495e325aa3'
  )
  and superseded_by is null;

update memory_note
set superseded_by = '15004f29-43ed-4235-bd90-8e1d2ff02c10',
    superseded_at = now(),
    supersession_rationale = 'L2 dedup 2026-06-23: duplicate of canonical dispatch-latency note 15004f29 (most complete — names the root cause). No info lost.'
where tenant_id = '73db45ff-457e-4541-bc8f-bdb625390204'
  and id in (
    'a4be4142-5aa5-4ebb-a013-c05389fc773d',
    '3a5b9b78-84ef-4c8b-b0d6-9d89ecb3a58a',
    '5449d63a-ef82-4200-8287-7e04b6638aa3'
  )
  and superseded_by is null;

update memory_recall_golden
set expected_note_ids = array['86264d23-0853-46ba-bd31-994b685e134f']::uuid[]
where tenant_id = '73db45ff-457e-4541-bc8f-bdb625390204'
  and query = 'what is our driver credit score threshold';

update memory_recall_golden
set expected_note_ids = array['15004f29-43ed-4235-bd90-8e1d2ff02c10']::uuid[]
where tenant_id = '73db45ff-457e-4541-bc8f-bdb625390204'
  and query = 'top priority backlog item right now';
