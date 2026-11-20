
export type ChannelRunStep = {
  key: string;
  label: string;
  state: "pending" | "running" | "done" | "failed";
};

const TOOL_LABELS: ReadonlyArray<readonly [string, { doing: string; done: string }]> = [
  ["memory__", { doing: "Checking your company brain", done: "Checked your company brain" }],
  ["brain__", { doing: "Updating your company brain", done: "Updated your company brain" }],
  ["company_facts__", { doing: "Checking your company facts", done: "Checked your company facts" }],
  ["operator_db__", { doing: "Reading your business data", done: "Read your business data" }],
  ["growth__", { doing: "Checking what past changes did", done: "Checked what past changes did" }],

  ["google_ads__", { doing: "Reading your Google Ads account", done: "Read your Google Ads account" }],
  ["meta_ads__", { doing: "Reading your Meta Ads account", done: "Read your Meta Ads account" }],
  ["google_analytics__", { doing: "Pulling your analytics", done: "Pulled your analytics" }],
  ["google_search_console__", { doing: "Pulling your search data", done: "Pulled your search data" }],
  ["stripe__", { doing: "Checking Stripe", done: "Checked Stripe" }],
  ["slack__", { doing: "Checking Slack", done: "Checked Slack" }],
  ["github__", { doing: "Looking at your code", done: "Looked at your code" }],
  ["jira__", { doing: "Checking your tickets", done: "Checked your tickets" }],
  ["linear__", { doing: "Checking your tickets", done: "Checked your tickets" }],
  ["reddit__", { doing: "Reading Reddit threads", done: "Read Reddit threads" }],
  ["linkedin__", { doing: "Reading LinkedIn posts", done: "Read LinkedIn posts" }],
  ["x__", { doing: "Reading posts on X", done: "Read posts on X" }],

  ["web_search__", { doing: "Searching the web", done: "Searched the web" }],
  ["web_fetch__", { doing: "Reading pages on the web", done: "Read pages on the web" }],
  ["apify__", { doing: "Reading pages on the web", done: "Read pages on the web" }],

  ["report__", { doing: "Putting the result together", done: "Put the result together" }],
  ["praxis__action", { doing: "Setting up the action", done: "Set up the action" }],
  ["praxis__handoff", { doing: "Bringing in a specialist", done: "Brought in a specialist" }],
];

const HIDDEN_TOOLS: ReadonlySet<string> = new Set(["assistant_turn", "ToolSearch"]);

export const GENERIC_TOOL_LABEL = { doing: "Checking a connected tool", done: "Checked a connected tool" } as const;

const WRITE_UP = {
  pending: "Write the steps up for your approval",
  doing: "Writing the steps up for your approval",
  done: "Wrote the steps up for your approval",
} as const;

const CONTEXT = {
  doing: "Reading your company setup",
  done: "Read your company setup",
} as const;

export function bareToolName(raw: string): string {
  return raw.startsWith("mcp__server__") ? raw.slice("mcp__server__".length) : raw;
}

export function labelForTool(raw: string): { doing: string; done: string } | null {
  const bare = bareToolName(raw);
  if (HIDDEN_TOOLS.has(bare) || HIDDEN_TOOLS.has(raw)) return null;
  for (const [prefix, label] of TOOL_LABELS) {
    if (bare.startsWith(prefix)) return label;
  }
  return GENERIC_TOOL_LABEL;
}

export type RunEventRow = {
  stage: string;
  meta: { tool_name?: string | null } | null;
};

export function buildChannelRunSteps(rows: readonly RunEventRow[]): ChannelRunStep[] {
  let sawContext = false;
  let sawWriteUpStart = false;
  let sawWriteUpDone = false;

  const order: string[] = [];
  const byLabel = new Map<string, { doing: string; done: string; completed: boolean; errored: boolean }>();

  for (const row of rows) {
    if (row.stage === "loaded_context") sawContext = true;
    if (row.stage === "envelope_extracted" || row.stage === "parsed") sawWriteUpStart = true;
    if (row.stage === "persisted" || row.stage === "completed") sawWriteUpDone = true;

    const toolName = typeof row.meta?.tool_name === "string" ? row.meta.tool_name : null;
    if (!toolName) continue;
    const label = labelForTool(toolName);
    if (!label) continue;

    const key = label.done;
    let entry = byLabel.get(key);
    if (!entry) {
      entry = { ...label, completed: false, errored: false };
      order.push(key);
      byLabel.set(key, entry);
    }
    if (row.stage === "tool_use_completed") entry.completed = true;
    if (row.stage === "tool_use_errored") entry.errored = true;
  }

  const steps: ChannelRunStep[] = [];

  if (sawContext) {
    steps.push({ key: CONTEXT.done, label: CONTEXT.done, state: "done" });
  }

  for (const key of order) {
    const e = byLabel.get(key)!;
    if (e.completed) steps.push({ key, label: e.done, state: "done" });
    else if (e.errored) steps.push({ key, label: e.doing, state: "failed" });
    else steps.push({ key, label: e.doing, state: "running" });
  }

  if (steps.length === 0 && !sawWriteUpStart && !sawWriteUpDone) return [];

  steps.push({
    key: WRITE_UP.done,
    label: sawWriteUpDone ? WRITE_UP.done : sawWriteUpStart ? WRITE_UP.doing : WRITE_UP.pending,
    state: sawWriteUpDone ? "done" : sawWriteUpStart ? "running" : "pending",
  });

  return steps;
}
