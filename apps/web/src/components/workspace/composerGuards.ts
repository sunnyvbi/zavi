
export function shouldBlockSend(args: {
  value: string;
  readyImagePathsCount: number;
  readyDocPathsCount?: number;
  readyVideoPathsCount?: number;
  inflight: boolean;
  submittingFeedback: boolean;
}): boolean {
  if (args.inflight || args.submittingFeedback) return true;
  if (args.readyImagePathsCount > 0) return false;
  if ((args.readyDocPathsCount ?? 0) > 0) return false;
  if ((args.readyVideoPathsCount ?? 0) > 0) return false;
  return /^[\s​-‍⁠]*$/u.test(args.value);
}

export function shouldTransparentlyHealThread(args: {
  errorCode: string | null | undefined;
  targetSlug: string;
  agentSlug: string;
  sentThreadId: string | null;
}): boolean {
  return (
    args.errorCode === "thread_not_found" &&
    args.targetSlug === args.agentSlug &&
    args.sentThreadId !== null
  );
}

export type SeedDrainAction =
  | { kind: "none" }
  | { kind: "focus_only" }
  | { kind: "autosend"; text: string }
  | { kind: "prefill"; text: string };

export function resolveSeedDrain(args: {
  seed: { text: string; nonce: number; autoSend?: boolean } | undefined;
  hasTypedText: boolean;
  alreadyFired: boolean;
}): SeedDrainAction {
  const { seed, hasTypedText, alreadyFired } = args;
  if (!seed) return { kind: "none" };
  if (hasTypedText) return { kind: "focus_only" };
  if (seed.autoSend) {
    if (alreadyFired) return { kind: "focus_only" };
    return { kind: "autosend", text: seed.text };
  }
  return { kind: "prefill", text: seed.text };
}

export type SendFailureOutcome = "failed" | "credits" | "invalid_command";

export function sendFailureInputPolicy(outcome: SendFailureOutcome): {
  restoreInput: boolean;
  retryBanner: boolean;
} {
  if (outcome === "credits") return { restoreInput: false, retryBanner: false };
  if (outcome === "invalid_command") return { restoreInput: true, retryBanner: false };
  return { restoreInput: true, retryBanner: true };
}

export function mayReplaceWithSeed(args: { current: string; lastSeeded: string | null }): boolean {
  const typed = args.current.trim();
  return typed.length === 0 || (args.lastSeeded !== null && typed === args.lastSeeded.trim());
}
