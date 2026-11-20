
export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const secs = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function decodeXmlEntities(text: string): string {
  if (!text) return "";
  let cur = text;
  for (let i = 0; i < 32; i++) {
    const next = cur
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&#39;/gi, "'")
      .replace(/&amp;/gi, "&");
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

const APPROVED_PLAN_SEP = /\s+Approved plan:\s/;
const CLARIFY_CONTEXT_SEP = /\s+Additional context:\s+-\s/;

export function formatTurnMessage(message: string): { text: string; planApplied: boolean } {
  const plan = message.search(APPROVED_PLAN_SEP);
  const ctx = message.search(CLARIFY_CONTEXT_SEP);
  const cuts = [plan, ctx].filter((i) => i >= 0);
  if (cuts.length === 0) return { text: decodeXmlEntities(message), planApplied: false };
  const head = decodeXmlEntities(message.slice(0, Math.min(...cuts)).trim());
  if (plan === -1) return { text: head.length > 0 ? head : decodeXmlEntities(message), planApplied: false };
  return { text: head.length > 0 ? head : "Applied the proposed plan", planApplied: true };
}

export function refineStatusBadge(
  status: string,
  opts?: { prUrl?: string | null; noShip?: boolean },
): { label: string; cls: string; title?: string } {
  const emerald = "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  const amber = "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  const red = "bg-red-50 text-red-700 ring-1 ring-red-200";
  const blue = "bg-blue-50 text-blue-700 ring-1 ring-blue-200";
  const zinc = "bg-zinc-100 text-zinc-600 ring-1 ring-zinc-200";
  const hasPr = Boolean(opts?.prUrl);
  switch (status) {
    case "done":
      return hasPr
        ? {
            label: "Ready to review",
            cls: amber,
            title:
              "Your AI team finished this change. It's parked and waiting to be published.",
          }
        : { label: "Shipped", cls: emerald };
    case "halted":
      if (opts?.noShip) {
        return {
          label: "Stopped",
          cls: zinc,
          title:
            "Your AI team couldn't ship this change. Nothing was applied to your app. See the note below and try again.",
        };
      }
      return hasPr
        ? {
            label: "Paused",
            cls: amber,
            title:
              "This change is paused. It's parked and waiting to be published.",
          }
        : {
            label: "Stopped",
            cls: zinc,
            title:
              "This change stopped before shipping. Nothing was applied to your app. You can try again.",
          };
    case "failed":
      return {
        label: "Failed",
        cls: red,
        title: opts?.noShip
          ? "This change didn't ship. See the note below and try again."
          : undefined,
      };
    case "active":
    case "provisioning":
      return { label: "Working…", cls: blue };
    case "proposed":
      return { label: "Queued", cls: zinc };
    case "held":
      return {
        label: "Needs review",
        cls: amber,
        title: "This change needs a quick review before it can continue.",
      };
    case "success":
      return { label: "Shipped", cls: emerald };
    case "cancelled":
      return { label: "Cancelled", cls: zinc };
    default:
      return {
        label: status ? status.charAt(0).toUpperCase() + status.slice(1) : "-",
        cls: zinc,
      };
  }
}

export function buildStatusBadge(status: "building" | "live" | "failed"): {
  label: string;
  cls: string;
} {
  switch (status) {
    case "live":
      return {
        label: "Live",
        cls: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
      };
    case "failed":
      return {
        label: "Failed",
        cls: "bg-red-50 text-red-700 ring-1 ring-red-200",
      };
    default:
      return {
        label: "Building…",
        cls: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
      };
  }
}

export type ProtectedPathHit = { path: string; glob: string };

export type GateEvidenceView = {
  build_ok: boolean;
  tests: { passed: number; failed: number };
  typecheck_ok: boolean | null;
  preview_smoke: {
    verdict: "pass" | "fail" | "skipped";
    evidence_md: string;
  };
  gate_verdict: "pass" | "fail";
  protected_paths?: ProtectedPathHit[];
};

export type DeployStatusView = {
  state: "deploy_watching" | "deploy_healthy" | "deploy_failed";
  pr_url: string;
  merged_sha: string;
  served_sha: string | null;
  health_url: string | null;
  reason: string | null;
  merged_at: string | null;
  updated_at: string | null;
  rollback_available: boolean;
};

export type GateLaneState =
  | "checking"
  | "review_ready"
  | "protected_hold"
  | "gate_failed"
  | "none";

export function deriveGateLaneState(
  refineStatus: string,
  gate: GateEvidenceView | null | undefined,
): GateLaneState {
  if (gate) {
    if (gate.gate_verdict === "pass") return "review_ready";
    if (gate.protected_paths && gate.protected_paths.length > 0)
      return "protected_hold";
    return "gate_failed";
  }
  if (refineStatus === "active" || refineStatus === "provisioning") return "checking";
  return "none";
}

export function deployStateBadge(state: DeployStatusView["state"]): {
  label: string;
  cls: string;
  spinning: boolean;
} {
  switch (state) {
    case "deploy_healthy":
      return {
        label: "Deployed",
        cls: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
        spinning: false,
      };
    case "deploy_failed":
      return {
        label: "Deploy failed",
        cls: "bg-red-50 text-red-700 ring-1 ring-red-200",
        spinning: false,
      };
    default:
      return {
        label: "Deploying…",
        cls: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
        spinning: true,
      };
  }
}
