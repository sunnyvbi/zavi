
import type { DeepAgentPromptProfile } from "./profiles/types";
import {
  MODEL_ADDENDUM_HEADER,
  PROFILE_HEADER,
} from "./profiles/types";

export function applyDeepAgentProfile(
  baseSystemPrompt: string,
  profile: DeepAgentPromptProfile,
  opts?: { includeHarnessOverlay?: boolean },
): string {
  const base = (baseSystemPrompt ?? "").trim();
  const parts: string[] = [];

  if (base) parts.push(base);

  const includeHarness = opts?.includeHarnessOverlay ?? base.length === 0;
  if (includeHarness && profile.harnessOverlay.trim()) {
    parts.push(`${PROFILE_HEADER}\n${profile.harnessOverlay.trim()}`);
  }

  if (profile.modelAddendum?.trim()) {
    parts.push(`${MODEL_ADDENDUM_HEADER}\n${profile.modelAddendum.trim()}`);
  }

  return parts.join("\n\n");
}

export function studioHarnessSystemPrompt(profile: DeepAgentPromptProfile): string {
  return applyDeepAgentProfile("", profile);
}
