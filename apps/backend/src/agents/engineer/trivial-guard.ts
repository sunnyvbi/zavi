
export interface TrivialGuardFile {
  path: string;
  action?: "create" | "modify" | "delete";
  diff?: string | null;
  content?: string | null;
}

export interface TrivialGuardSignals {
  files: ReadonlyArray<TrivialGuardFile>;
  httpRouteChanged?: boolean;
}

export type EngineerRiskClass = "trivial" | "low" | "medium";

export const TRIVIAL_MAX_CHANGED_LINES = 20;

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const DEP_MANIFEST =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.ya?ml|yarn\.lock)$/i;
const CONFIG_FILE =
  /(^|\/)(tsconfig[^/]*\.json|[^/]*\.config\.[cm]?[jt]s|dockerfile|docker-compose[^/]*\.ya?ml|\.env[^/]*)$/i;
const GENERATED = /(^|\/)(dist|build|out|generated|__generated__)\//i;
const MIGRATION = /(^|\/)(supabase\/)?migrations\//i;
const SENSITIVE_PATH =
  /(^|\/|[-_.])(billing|payments?|payout|stripe|checkout|invoice|subscription|pricing|refund|auth|authz|authentication|authorization|session|login|signin|signup|password|oauth|token|jwt|secret|credential|webhook|rls|tenant-isolation)([-_./]|$)/i;

function isNonTrivialPath(path: string): boolean {
  const p = path || "";
  return (
    TEST_FILE.test(p) ||
    DEP_MANIFEST.test(p) ||
    CONFIG_FILE.test(p) ||
    GENERATED.test(p) ||
    MIGRATION.test(p) ||
    SENSITIVE_PATH.test(p)
  );
}

function countChangedLines(f: TrivialGuardFile): number {
  if (typeof f.diff === "string" && f.diff.length > 0) {
    let n = 0;
    for (const line of f.diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) n++;
      else if (line.startsWith("-") && !line.startsWith("---")) n++;
    }
    return n;
  }
  if (f.action !== "delete" && typeof f.content === "string") {
    return f.content.length === 0 ? 0 : f.content.split("\n").length;
  }
  return 0;
}

export function isServerTrivial(sig: TrivialGuardSignals): boolean {
  if (sig.httpRouteChanged) return false;
  let total = 0;
  for (const f of sig.files) {
    if (isNonTrivialPath(f.path)) return false;
    total += countChangedLines(f);
    if (total > TRIVIAL_MAX_CHANGED_LINES) return false;
  }
  return true;
}

export function effectiveRiskClass(
  modelRisk: unknown,
  sig: TrivialGuardSignals,
): EngineerRiskClass {
  const r: EngineerRiskClass =
    modelRisk === "trivial" || modelRisk === "low" || modelRisk === "medium"
      ? modelRisk
      : "low";
  if (r !== "trivial") return r;
  return isServerTrivial(sig) ? "trivial" : "low";
}
