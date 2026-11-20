
export interface SummonSurfaceEntry {
  key: string;
  dashboard_slug: string;
  label: string;
  summoned_by: readonly string[];
  trigger: RegExp;
}

const KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const SUMMON_REGISTRY: readonly SummonSurfaceEntry[] = [
  {
    key: "builds",
    dashboard_slug: "engineer",
    label: "Your builds",
    summoned_by: ["operator"],
    trigger:
      /\bpull[- ]requests?\b|\b(?:open|my|any|the)\s+PRs?\b|\bPRs?\s+(?:waiting|open|ready|awaiting)\b|\bawaiting\s+(?:my\s+)?(?:merge|review)\b|\bwaiting\s+on\s+(?:my\s+)?merge\b|\bready\s+to\s+merge\b|\bmerge\s+queue\b|\b(?:build|deploy(?:ment)?)\s+status\b|\bstatus\s+of\s+(?:the|my|this|our)\s+(?:build|deploy(?:ment)?|pull request)\b|\bwhat\s+(?:have\s+you|did\s+you)\s+ship(?:ped)?\b|\bwhat'?s\s+shipped\b|\bdid\s+(?:the|my)\s+build\s+(?:pass|finish|work|succeed|fail)\b/i,
  },
];

export type SummonedSurface = {
  key: string;
  dashboard_slug: string;
  label: string;
};

export function surfacesForAgent(agentSlug: string): SummonSurfaceEntry[] {
  if (typeof agentSlug !== "string" || agentSlug.length === 0) return [];
  return SUMMON_REGISTRY.filter((s) => s.summoned_by.includes(agentSlug));
}

export function resolveSummonedSurface(
  agentSlug: string,
  taskText: string,
): SummonedSurface | null {
  if (typeof taskText !== "string" || taskText.trim().length === 0) return null;
  for (const s of surfacesForAgent(agentSlug)) {
    if (!KEY_RE.test(s.key)) continue;
    if (s.trigger.test(taskText)) {
      return {
        key: s.key,
        dashboard_slug: s.dashboard_slug,
        label: s.label,
      };
    }
  }
  return null;
}
