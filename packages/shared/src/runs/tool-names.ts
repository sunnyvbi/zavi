
const TOOL_VERB: Record<string, string> = {
  run_bash: "Run",
  bash: "Run",
  view: "View",
  read: "Read",
  str_replace: "Edit",
  edit: "Edit",
  edit_file: "Edit",
  create: "Write",
  create_file: "Write",
  write: "Write",
  toolsearch: "Search",
  grep: "Search",
  search: "Search",
  web_search: "Web",
  list: "List",
  list_files: "List",
  list_ad_sets: "List",
  list_ad_set: "List",
  list_campaigns: "List",
  get: "Get",
  fetch: "Fetch",
  query: "Query",
};

const INTERNAL_TOOLS = new Set(["handoff", "handoff_parallel"]);

const INTERNAL_SERVERS = new Set(["praxis", "mcp", "server"]);

export function isInternalToolName(raw: string | null | undefined): boolean {
  const name = (raw ?? "").trim();
  if (!name) return false;
  const bare = shortToolName(name).toLowerCase();
  if (!INTERNAL_TOOLS.has(bare)) return false;
  const segments = name.toLowerCase().split("__");
  if (segments.length === 1) return true;
  return INTERNAL_SERVERS.has(segments[segments.length - 2] ?? "");
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function shortToolName(raw: string): string {
  return (raw.split("__").pop() ?? raw).trim();
}

export function humanizeToolName(raw: string | null | undefined): string {
  const name = (raw ?? "").trim();
  if (!name) return "tool";
  const bare = shortToolName(name);
  if (!bare) return "tool";
  const verb = TOOL_VERB[bare.toLowerCase()];
  if (verb) return verb;
  const titled = titleCase(bare);
  return titled || "tool";
}
