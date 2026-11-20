
export const CREDIT_REFUSAL_CODES = [
  "insufficient_credits",
  "insufficient_credits_for_build",
  "out_of_credits",
  "build_credits_exhausted",
] as const;

export type CreditRefusalContext = "build" | "change" | "channel" | "scan" | "plan" | "video" | "photo";

export type CreditRefusal = {
  headline: string;
  detail: string;
  subline: string | null;
};

export const FREE_EDITS_USED_CODE = "free_edits_used";
const FREE_EDITS_USED_FALLBACK =
  "You've used your 2 free edits. Editing your app needs Starter ($20/mo), or buy credits.";

type ErrorBody = {
  error?: {
    code?: unknown;
    message?: unknown;
    required_credits?: unknown;
    remaining_credits?: unknown;
    free_plan?: unknown;
    reason?: unknown;
    ahead_credits?: unknown;
  };
} | null | undefined;

function fmt(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString("en-US");
}

const COPY: Record<CreditRefusalContext, { headline: string; detail: string }> = {
  build: { headline: "Not enough credits for this build.", detail: " Top up to start it." },
  change: { headline: "Not enough credits for this change.", detail: " Top up to make it." },
  channel: { headline: "Out of credits.", detail: " Top up to run this channel." },
  scan: { headline: "Out of credits.", detail: " Top up to run the competitor scan." },
  plan: { headline: "Out of credits.", detail: " Top up to draft your growth plan." },
  video: { headline: "Not enough credits for this video.", detail: " Top up to make it." },
  photo: { headline: "Not enough credits for this photo.", detail: " Top up to make it." },
};

export function isCreditRefusalCode(code: unknown): boolean {
  return typeof code === "string" && (CREDIT_REFUSAL_CODES as readonly string[]).includes(code);
}

export function creditRefusalFrom(
  body: unknown,
  context: CreditRefusalContext,
): CreditRefusal | null {
  const err = (body as ErrorBody)?.error;
  if (err?.code === FREE_EDITS_USED_CODE) {
    const message =
      typeof err.message === "string" && err.message.trim() ? err.message.trim() : FREE_EDITS_USED_FALLBACK;
    return { headline: message, detail: "", subline: null };
  }
  if (!err || !isCreditRefusalCode(err.code)) return null;
  if (context === "build" && err.free_plan === true) {
    return {
      headline: "Not enough credits for this build.",
      detail: " The free plan's daily credits don't cover it.",
      subline: "Top up or pick a plan to start it.",
    };
  }
  if (context === "change" && err.free_plan === true) {
    return {
      headline: "Not enough credits for this change.",
      detail: " The free plan's daily credits don't cover it.",
      subline: "Upgrade or top up to make it.",
    };
  }
  if (context === "video" && err.reason === "videos_ahead") {
    const required = err.required_credits;
    const ahead = err.ahead_credits;
    const known = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
    return {
      headline: "Not enough credits for this video while your other videos are still being made.",
      detail: " Top up to make it.",
      subline:
        known(required) && known(ahead)
          ? `This one needs about ${fmt(required)} credits · videos being made need about ${fmt(ahead)}`
          : "The videos already being made use up the credits you have.",
    };
  }
  const { headline, detail } = COPY[context];
  const required = err.required_credits;
  const remaining = err.remaining_credits;
  const subline =
    typeof required === "number" && typeof remaining === "number" && Number.isFinite(required) && Number.isFinite(remaining)
      ? `Needs about ${fmt(required)} credits · you have ${fmt(remaining)}`
      : null;
  return { headline, detail, subline };
}

export const BUILD_PAUSED_REFUSAL: CreditRefusal = {
  headline: "Your build is paused: out of credits.",
  detail: " Everything built so far is saved.",
  subline: "Top up, then continue the build.",
};

export const BUILD_STOPPED_REFUSAL: CreditRefusal = {
  headline: "This build stopped: out of credits.",
  detail: " Nothing more will be charged.",
  subline: "Top up, then start the build again.",
};

export class CreditRefusalError extends Error {
  constructor(public readonly refusal: CreditRefusal) {
    super(refusal.headline);
    this.name = "CreditRefusalError";
  }
}
