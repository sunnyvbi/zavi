
export const NEVER_DISTILL = new Set<string>([
]);

export type ShouldDistillInput = {
  agent_slug: string;
  trigger: "chat" | "cron" | "manual" | "decision" | "webhook" | string;
  output_text_len?: number;
  is_seed?: boolean;
  used_brain_correction?: boolean;
  has_pending_proposals?: boolean;
};

export type ShouldDistillResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "public_input_agent"
        | "output_too_short"
        | "trigger_excluded"
        | "seed_run"
        | "brain_correction_turn";
    };

export function shouldDistillRun(input: ShouldDistillInput): ShouldDistillResult {
  if (NEVER_DISTILL.has(input.agent_slug)) {
    return { ok: false, reason: "public_input_agent" };
  }

  if (input.used_brain_correction === true) {
    return { ok: false, reason: "brain_correction_turn" };
  }

  if (input.is_seed === true) {
    return { ok: false, reason: "seed_run" };
  }

  if (input.trigger !== "chat" && !input.has_pending_proposals && (input.output_text_len ?? 0) < 50) {
    return { ok: false, reason: "output_too_short" };
  }

  return { ok: true };
}

export function queuedMemoryProposal(toolCalls: unknown): boolean {
  if (!Array.isArray(toolCalls)) return false;
  return toolCalls.some(
    (t) =>
      !!t &&
      typeof (t as { name?: unknown }).name === "string" &&
      (t as { name: string }).name.endsWith("memory__write") &&
      (t as { status?: unknown }).status === "ok",
  );
}

export function makeShouldDistillRun(neverDistill: Set<string>) {
  return (input: ShouldDistillInput): ShouldDistillResult => {
    if (neverDistill.has(input.agent_slug)) {
      return { ok: false, reason: "public_input_agent" };
    }
    if (input.used_brain_correction === true) {
      return { ok: false, reason: "brain_correction_turn" };
    }
    if (input.is_seed === true) {
      return { ok: false, reason: "seed_run" };
    }
    if (input.trigger !== "chat" && (input.output_text_len ?? 0) < 50) {
      return { ok: false, reason: "output_too_short" };
    }
    return { ok: true };
  };
}
