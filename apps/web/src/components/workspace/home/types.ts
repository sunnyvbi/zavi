
export type ActiveRunRow = {
  id: string;
  agent_slug: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  presentation_status?: "answered" | "failed" | "running" | "cancelled";
};

export type SpendBucket = {
  date: string;
  usd: number;
};

export type SuggestedNextRow = {
  feedback_id: string;
  agent_slug: string;
  suggestion_text: string;
  created_at: string;
};

export type KeyFact = { label: string; value: string };

export type CompanyMdRef = {
  id: string;
  title: string;
  updated_at: string;
  source: "human" | "agent_write" | string;
  metadata?: { key_facts?: KeyFact[] };
};

export type ActivityRow = {
  agent_slug: string;
  finished_at: string | null;
  cost_usd: number;
};

export interface HomeGoal {
  id: string;
  objective: string;
  target_metric: string;
  target_value: number;
  baseline_value: number | null;
  current_value: number | null;
  due_date: string | null;
  status: string;
  priority: number;
  source: string;
}

export interface HomeStat {
  label: string;
  value: string;
  status?: "measured" | "unavailable";
  unit?: "count" | "usd" | "ratio";
  direction?: "up" | "down" | "context";
  source: string;
  metric_key?: string;
  window_end?: string;
  target?: string;
  progress?: number;
  goal_id?: string;
}

export type HomeSummaryPayload = {
  active_runs_today: ActiveRunRow[];
  spend_week: SpendBucket[];
  spend_total_usd: number;
  suggested_next: SuggestedNextRow[];
  company_md_ref: CompanyMdRef | null;
  pending_approvals_count: number;
  recent_activity: ActivityRow[];
  goals?: HomeGoal[];
  business_stats?: HomeStat[];
};
