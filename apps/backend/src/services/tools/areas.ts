
export type ToolArea = {
  id: string;
  name: string;
  description: string;
  tool_slugs: string[];
};

export const CANONICAL_AREAS: ToolArea[] = [
  {
    id: "slack_ops",
    name: "Slack",
    description: "Read and send across the operator's Slack workspace.",
    tool_slugs: ["slack_list_channels", "slack_get_channel_history"],
  },
  {
    id: "memory_ops",
    name: "Brain memory",
    description: "Search + write the tenant's memory notes.",
    tool_slugs: [],
  },
  {
    id: "github_ops",
    name: "GitHub",
    description: "Open and review PRs, issues, code search.",
    tool_slugs: [],
  },
  {
    id: "stripe_ops",
    name: "Stripe",
    description: "List charges, process refunds, file dispute evidence.",
    tool_slugs: [],
  },
  {
    id: "gmail_ops",
    name: "Gmail",
    description: "Send, search, draft email.",
    tool_slugs: [],
  },
  {
    id: "agent_meta",
    name: "Agent orchestration",
    description: "Spawn and read agent runs; dispatch decisions.",
    tool_slugs: [],
  },
];
