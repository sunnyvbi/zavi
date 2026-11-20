
export const SDK_HARNESS_META_TOOLS: ReadonlySet<string> = new Set([
  "ToolSearch",
  "StructuredOutput",
]);

export function isSdkHarnessMetaTool(name: unknown): boolean {
  return typeof name === "string" && SDK_HARNESS_META_TOOLS.has(name);
}

export const SDK_03_NEW_BUILTINS = [
  "Workflow",
  "TaskCreate",
  "TaskGet",
  "TaskUpdate",
  "TaskList",
  "DesignSync",
  "ListAgents",
  "ReportFindings",
  "ReadMcpResourceDirTool",
] as const;

export const SDK_CONTRACT_FOUND_BUILTINS = [
  "CronCreate",
  "CronDelete",
  "CronList",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "LSP",
  "ListMcpResourcesTool",
  "Monitor",
  "PushNotification",
  "ReadMcpResourceTool",
  "RemoteTrigger",
  "ScheduleWakeup",
  "SendMessage",
  "Skill",
  "TaskStop",
] as const;

export const SDK_DISALLOWED_BUILTINS: readonly string[] = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Grep",
  "Glob",
  "Task",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "TodoWrite",
  "KillShell",
  "BashOutput",
  "SlashCommand",
  ...SDK_03_NEW_BUILTINS,
  ...SDK_CONTRACT_FOUND_BUILTINS,
];

export const SDK_ALLOWED_BUILTINS: ReadonlySet<string> = new Set<string>(["AskUserQuestion"]);

export type SdkToolClass = "harness-meta" | "disallowed-builtin" | "allowed-builtin" | "unclassified";

export function classifySdkTool(name: string): SdkToolClass {
  if (isSdkHarnessMetaTool(name)) return "harness-meta";
  if (SDK_DISALLOWED_BUILTINS.includes(name)) return "disallowed-builtin";
  if (SDK_ALLOWED_BUILTINS.has(name)) return "allowed-builtin";
  return "unclassified";
}
