
alter table public.system_config          enable row level security;
alter table public.slack_triage_window    enable row level security;
alter table public.slack_triage_claims    enable row level security;
alter table public.memory_recall_golden   enable row level security;
alter table public.memory_recall_eval_run enable row level security;
alter table public.tenant_seat_limits     enable row level security;

revoke all on
  public.system_config,
  public.slack_triage_window,
  public.slack_triage_claims,
  public.memory_recall_golden,
  public.memory_recall_eval_run,
  public.tenant_seat_limits
from anon, authenticated;
