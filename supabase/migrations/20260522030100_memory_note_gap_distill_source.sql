
alter table memory_note drop constraint if exists memory_note_source_check;

alter table memory_note
  add constraint memory_note_source_check check (
    source in (
      'human',
      'agent_run',
      'slack_distill',
      'email_distill',
      'operator_feedback',
      'praxis_staff',
      'auto_distill_chat',
      'auto_distill_agent_run',
      'auto_distill_slack',
      'dream_cycle_merge',
      'agent_write',
      'gap_distill'
    )
  );
