
import { effectOf } from "./tool-effects";
import { INTERNAL_SERVERS } from "./internal-servers";

export { INTERNAL_SERVERS };

export function isSideEffectingTool(server_id: string, tool_name: string): boolean {
  if (!INTERNAL_SERVERS.has(server_id)) return false;
  return effectOf(server_id, tool_name) !== "read";
}
