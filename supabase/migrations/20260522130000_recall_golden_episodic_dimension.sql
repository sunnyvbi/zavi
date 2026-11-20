
alter table memory_recall_golden add column if not exists agent_slug text;
alter table memory_recall_golden add column if not exists expected_order uuid[];
