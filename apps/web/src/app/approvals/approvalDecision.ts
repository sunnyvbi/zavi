export type Decision = {
  post_revision?: string;
  id: string;
  agent_run_id: string | null;
  decision_class: string;
  body: Record<string, unknown>;
  status: string;
  autonomy_at_emit: string;
  handler: string | null;
  emitted_at: string;
  agent_slug?: string | null;
  thread_id?: string | null;
  channel_slug?: string | null;
  click_allowlistable?: boolean;
  dispatch_error?: string | null;
  failure_fix?: string | null;
  approved_at?: string | null;
  dispatched_at?: string | null;
};
