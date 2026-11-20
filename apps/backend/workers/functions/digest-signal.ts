
import type { MorningBriefResponse } from "../../src/services/workspace/morning-brief-assembler";

export function briefHasSignal(brief: MorningBriefResponse): boolean {
  if (brief.recent_activity.length > 0) return true;
  if (brief.today.pending_approvals > 0) return true;
  if ((brief.today.pending_suggestions ?? 0) > 0) return true;
  if (brief.yesterday.builds_done > 0 || brief.yesterday.builds_failed > 0) {
    return true;
  }
  if (brief.yesterday.spend_usd > 0) return true;
  if (
    brief.goals.some((g) => g.current_value != null || g.target_value != null)
  ) {
    return true;
  }
  return false;
}

export function briefIsSetupOnly(brief: MorningBriefResponse): boolean {
  if (briefHasSignal(brief)) return false;
  const hasShallowActivity =
    brief.goals.length > 0 ||
    brief.today.proposed_plans > 0 ||
    brief.yesterday.builds_started > 0;
  return hasShallowActivity;
}
