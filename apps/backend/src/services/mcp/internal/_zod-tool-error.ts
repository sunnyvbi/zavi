
import type { ZodError } from "zod";
import type { McpCallResult } from "../types";

export const MAX_ZOD_ISSUES = 10;
const MAX_ISSUE_MESSAGE = 200;
const MAX_PATH = 120;
const SAFE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function pathOf(path: ReadonlyArray<PropertyKey>): string {
  return path
    .map((seg) => (typeof seg === "number" ? String(seg) : typeof seg === "string" && SAFE_SEGMENT.test(seg) ? seg : "*"))
    .join(".")
    .slice(0, MAX_PATH);
}

export function zodToolErrorResult(
  trace: { tenant_id: string; run_id: string | null },
  server: string,
  tool_name: string,
  e: ZodError,
  ms: number,
): McpCallResult {
  const all = e.issues;
  const issues = all.slice(0, MAX_ZOD_ISSUES).map((i) => ({
    path: pathOf(i.path),
    code: String(i.code).slice(0, 40),
    message: String(i.message ?? "").slice(0, MAX_ISSUE_MESSAGE),
  }));
  const fields = [...new Set(issues.map((i) => i.path || "(root)"))].join(", ");
  void import("@/services/logging/logEvent")
    .then(({ logEvent }) =>
      logEvent({
        level: "warn",
        source: `mcp.${server}`,
        code: "tool_invalid_input",
        tenant_id: trace.tenant_id,
        run_id: trace.run_id && /^[0-9a-f-]{36}$/i.test(trace.run_id) ? trace.run_id : null,
        meta: { tool_name: `${server}__${tool_name}`.slice(0, 64), count: all.length },
      }),
    )
    .catch(() => undefined);
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({
      error: "invalid_input",
      message: `${server}/${tool_name}: the arguments did not pass validation (${fields}). Nothing was filed. Fix those fields and call it again.`.slice(0, 600),
      issues,
      ...(all.length > issues.length ? { more_issues: all.length - issues.length } : {}),
    }),
    ms,
  };
}
