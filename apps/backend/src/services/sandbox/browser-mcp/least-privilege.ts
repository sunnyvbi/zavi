
import { ALL_BROWSER_TOOL_NAMES } from "./types";

const DANGEROUS_SERVERS: ReadonlySet<string> = new Set([
  "stripe",
  "meta_ads",
  "google_ads",
  "github",
  "email",
  "gmail",
  "slack",
  "teams",
  "buffer",
  "jira",
  "linear",
]);

const PRIVILEGED_TOOL_PATTERNS: readonly RegExp[] = [
  /refund/i,
  /payout/i,
  /ban_user/i,
  /merge_pr/i,
  /open_pr/i,
  /create_issue/i,
  /\bsend\b|_send|send_/i,
  /charge/i,
  /transfer/i,
];

function isBrowserTool(t: string): boolean {
  return (ALL_BROWSER_TOOL_NAMES as readonly string[]).includes(t);
}

function isDangerousServerTool(t: string): boolean {
  const idx = t.indexOf("__");
  if (idx <= 0) return false;
  return DANGEROUS_SERVERS.has(t.slice(0, idx));
}

export class BrowserLeastPrivilegeError extends Error {
  constructor(public readonly offendingTools: string[]) {
    super(
      `browser-driving run also declares privileged tools [${offendingTools.join(
        ", ",
      )}] — refused. A run with browser_* must not co-declare ` +
        `money/code/outbound tools (prompt-injection containment). Split into ` +
        `separate runs or route the action through the approval gate.`,
    );
    this.name = "BrowserLeastPrivilegeError";
  }
}

export function assertBrowserLeastPrivilege(
  declaredTools: readonly string[],
): void {
  const hasBrowser = declaredTools.some(isBrowserTool);
  if (!hasBrowser) return;
  const offending = declaredTools.filter(
    (t) =>
      !isBrowserTool(t) &&
      (PRIVILEGED_TOOL_PATTERNS.some((re) => re.test(t)) ||
        isDangerousServerTool(t)),
  );
  if (offending.length > 0) throw new BrowserLeastPrivilegeError(offending);
}
