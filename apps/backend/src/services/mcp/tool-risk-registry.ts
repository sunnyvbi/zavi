
import { INTERNAL_SERVERS, isSideEffectingTool } from "./tool-effect-classifier";
import { isAllowedWriteTool, looksLikeWriteToolName } from "./write-allowlist";
import { isMeteredWriteTool } from "./higgsfield-meter";

export type ToolRiskClass =
  | "read"
  | "write_low"
  | "write_external"
  | "write_code"
  | "write_money";

export function isWriteClass(cls: ToolRiskClass): boolean {
  return cls !== "read";
}

export function isE3WriteClass(cls: ToolRiskClass): boolean {
  return cls === "write_money" || cls === "write_code" || cls === "write_external";
}

const MONEY_WRITE_SERVERS: ReadonlySet<string> = new Set([
  "stripe",
  "google_ads",
  "meta_ads",
  "paid_acquisition",
]);

const CODE_WRITE_SERVERS: ReadonlySet<string> = new Set(["github"]);

const EXTERNAL_WRITE_SERVERS: ReadonlySet<string> = new Set([
  "slack",
  "email",
  "jira",
  "linear",
  "buffer",
  "tiktok",
  "extension",
]);

const SANDBOX_READ_TOOLS: ReadonlySet<string> = new Set([
  "view",
  "read",
  "read_file",
  "ls",
  "cat",
]);
const BROWSER_READ_TOOLS: ReadonlySet<string> = new Set([
  "browser_screenshot",
  "browser_text",
  "browser_read",
  "browser_get_page_text",
  "screenshot",
  "read_page",
  "get_page_text",
  "task",
]);

export function classifyToolRisk(server_id: string, tool_name: string): ToolRiskClass {
  if (server_id === "sandbox") {
    return SANDBOX_READ_TOOLS.has(tool_name) ? "read" : "write_code";
  }
  if (server_id === "browser") {
    return BROWSER_READ_TOOLS.has(tool_name) ? "read" : "write_external";
  }

  const remoteMoney = isMeteredWriteTool(server_id, tool_name);
  const remoteAllowedWrite = isAllowedWriteTool(server_id, tool_name);
  const internalWrite = isSideEffectingTool(server_id, tool_name);
  if (!internalWrite && !remoteAllowedWrite && !remoteMoney) {
    if (looksLikeWriteToolName(tool_name) && !INTERNAL_SERVERS.has(server_id)) {
      return "write_external";
    }
    return "read";
  }

  if (remoteMoney || (server_id === "geo" && tool_name === "start_answer_check")) return "write_money";
  if (MONEY_WRITE_SERVERS.has(server_id)) return "write_money";

  if (CODE_WRITE_SERVERS.has(server_id)) return "write_code";

  if (EXTERNAL_WRITE_SERVERS.has(server_id)) return "write_external";

  return "write_low";
}
