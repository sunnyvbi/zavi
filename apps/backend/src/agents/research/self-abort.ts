export const RESEARCH_UNVERIFIED_FALLBACK =
  "I couldn't put together a verified, cited analysis this time — the research " +
  "didn't come back in a structured form I can stand behind, so I'm not going to " +
  "show you numbers I can't back up. Want me to run it again?";

export const RESEARCH_SELF_ABORT_SENTINEL = "skipped:research-self-abort";

export function isResearchSelfAbortOutput(
  agentSlug: string,
  outputText: string | null,
): boolean {
  return agentSlug === "research" && outputText === RESEARCH_UNVERIFIED_FALLBACK;
}
