
export type AgentSummary = {
  slug: string;
  name: string;
  description: string;
  content_hash: string;
  metadata_praxis: {
    model: string;
    manual_only: boolean;
    side_effects: boolean;
    cost_class: "cheap" | "standard" | "expensive";
    sla_class?: "realtime" | "prompt" | "daily" | "bulk";
    kill_switch: boolean;
    decision_class?: string;
    impact_classes: string[];
    cron: string;
    triggers: string[];
    runtime: string;
  };
};

export type AgentRunStatus = "success" | "parse_failed" | "dispatch_error";
