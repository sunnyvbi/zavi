

export const BUILD_ESTIMATE = "a few minutes";

export const BUILD_ESTIMATE_NOTE = `Builds usually take ${BUILD_ESTIMATE}.`;

export type FounderBuildFailureCode =
  | "out_of_credits"
  | "safety_limit"
  | "service_busy"
  | "stopped_by_you"
  | "stalled"
  | "setup_failed"
  | "team_review"
  | "database_setup_failed"
  | "publish_failed"
  | "checks_failed"
  | "fixes_exhausted"
  | "internal";

export const FOUNDER_BUILD_FAILURE_CODES: ReadonlyArray<FounderBuildFailureCode> = [
  "out_of_credits",
  "safety_limit",
  "service_busy",
  "stopped_by_you",
  "stalled",
  "setup_failed",
  "team_review",
  "database_setup_failed",
  "publish_failed",
  "checks_failed",
  "fixes_exhausted",
  "internal",
];

export const BUILD_OUT_OF_CREDITS =
  "This build ran out of credits partway through. Nothing further will be charged. Top up or upgrade your plan, then start the build again.";

export const BUILD_NO_CREDITS_TO_START =
  "This build couldn't start: there weren't enough credits. Nothing further will be charged. Top up or upgrade your plan, then start it again.";

export const BUILD_OVER_BUDGET =
  "This build stopped at its safety limit before it finished. Nothing further will be charged. Start it again to continue.";

export const BUILD_PROVIDER_BUSY =
  "Our AI service was busy, so the build couldn't continue. Nothing is wrong with your app. Try again in a minute.";

export const BUILD_STOPPED_BY_YOU = "You stopped this build. To build it again, describe it in the message box.";

export const BUILD_STOPPED_BY_YOU_RESTART = "You stopped this build. Press Start again to rebuild it from the same brief.";

export const BUILD_STALLED =
  "This build stopped because one of its steps stopped responding. Nothing further will be charged. Start it again.";

export const BUILD_SETUP_FAILED =
  "We couldn't set up a workspace for your app, so the build didn't start. Start a new build in a few minutes. If it keeps happening, contact support.";

export const BUILD_TEAM_REVIEW =
  "Our team stopped this build to look at it more closely. You don't need to do anything right now.";

export const BUILD_DATABASE_SETUP_FAILED =
  "We couldn't set up your app's database, so the build stopped. Try again. If it keeps happening, contact support.";

export const BUILD_PUBLISH_FAILED =
  "Your app was built, but putting it online didn't finish. Try again.";

export const BUILD_CHECKS_FAILED =
  "Your app was built, but it didn't pass our final checks, so we held it back. Try again, or describe what you want a little differently.";

export const BUILD_FIXES_EXHAUSTED =
  "Zavi couldn't get one step of your app working. Try again, or describe your app a little differently.";

export const SITE_DATABASE_WAITING = "Getting your site's database ready, this can take a few minutes.";

export const SITE_DATABASE_SLOW =
  "Your site's database is taking longer than usual to get ready. Nothing is wrong with your site. Try publishing again in a few minutes.";

export const SITE_PUBLISH_PLATFORM_RETRY =
  "Publishing hit a temporary problem on our side, so this version did not go live. Try publishing again in a few minutes.";

export const BUILD_INTERNAL_FAILURE =
  "Something went wrong on our side, so this build couldn't finish. Try again. If it keeps happening, contact support.";

export type FounderBuildFailure = { code: FounderBuildFailureCode; message: string };

export function isOutOfCreditsReason(reason: string | null | undefined): boolean {
  return !!reason && reason.toLowerCase().includes("insufficient_credits");
}

function isProviderBusy(reason: string): boolean {
  return (
    /provider_capacity|overloaded/i.test(reason) ||
    /claude code[\s\S]*api error:\s*(429|529)\b/i.test(reason)
  );
}

function isOverBudget(reason: string): boolean {
  return /over_cap|budget_exceeded|budget_halted|spend cap reached|build budget reached/i.test(reason);
}

const COPY: Record<Exclude<FounderBuildFailureCode, "out_of_credits">, string> = {
  safety_limit: BUILD_OVER_BUDGET,
  service_busy: BUILD_PROVIDER_BUSY,
  stopped_by_you: BUILD_STOPPED_BY_YOU,
  stalled: BUILD_STALLED,
  setup_failed: BUILD_SETUP_FAILED,
  team_review: BUILD_TEAM_REVIEW,
  database_setup_failed: BUILD_DATABASE_SETUP_FAILED,
  publish_failed: BUILD_PUBLISH_FAILED,
  checks_failed: BUILD_CHECKS_FAILED,
  fixes_exhausted: BUILD_FIXES_EXHAUSTED,
  internal: BUILD_INTERNAL_FAILURE,
};

const BY_CLASS: Partial<Record<string, Exclude<FounderBuildFailureCode, "out_of_credits">>> = {
  user_cancelled: "stopped_by_you",
  stale_reaped: "stalled",
  budget_halted: "safety_limit",
  class_cap_halted: "safety_limit",
  provider_capacity: "service_busy",
  provision_failed: "setup_failed",
  coach_precedence: "team_review",
  app_database_setup: "database_setup_failed",
  deploy_failed: "publish_failed",
  acceptance_failed: "checks_failed",
  repair_exhausted: "fixes_exhausted",
};

export function isFounderBuildFailureCode(value: unknown): value is FounderBuildFailureCode {
  return typeof value === "string" && (FOUNDER_BUILD_FAILURE_CODES as ReadonlyArray<string>).includes(value);
}

export function founderBuildFailure(
  failure: { class?: string | null; message?: string | null } | null | undefined,
  opts: {
    startedWork?: boolean;
    authoredCopy?: string | null;
  } = {},
): FounderBuildFailure | null {
  if (!failure) return null;
  const cls = (failure.class ?? "").trim();
  const raw = (failure.message ?? "").trim();
  if (!cls && !raw) return null;
  if (cls === "user_cancelled" || cls === "coach_precedence") {
    const code = BY_CLASS[cls]!;
    return { code, message: COPY[code] };
  }
  if (isOutOfCreditsReason(raw)) {
    return {
      code: "out_of_credits",
      message: opts.startedWork === true ? BUILD_OUT_OF_CREDITS : BUILD_NO_CREDITS_TO_START,
    };
  }
  let code = BY_CLASS[cls];
  if (!code && raw) {
    if (isOverBudget(raw)) code = "safety_limit";
    else if (isProviderBusy(raw)) code = "service_busy";
  }
  code ??= "internal";
  const authored = cleanAuthored(opts.authoredCopy) ?? authoredFounderCopy(raw);
  return { code, message: authored ?? COPY[code] };
}

const AUTHORED_FOUNDER_OPENINGS = [
  "Couldn't set up your site's ",
  "We couldn't set up your new site",
  "Paused for more than 7 days",
  "This build changed files Zavi never publishes",
  "This site's build was stopped while this step was still working",
  "Zavi couldn't confirm this site while publishing",
  "Your site's database is taking longer than usual",
  "Publishing hit a temporary problem on our side",
] as const;

const AUTHORED_MAX_CHARS = 300;

function cleanAuthored(text: string | null | undefined): string | null {
  const line = (text ?? "").split("\n")[0].trim();
  return line && line.length <= AUTHORED_MAX_CHARS ? line : null;
}

export function authoredFounderCopy(raw: string | null | undefined): string | null {
  if (!raw) return null;
  for (const opening of AUTHORED_FOUNDER_OPENINGS) {
    const at = raw.indexOf(opening);
    if (at >= 0) return cleanAuthored(raw.slice(at));
  }
  return null;
}

export const BUILD_STAGE_RETRYING = "Zavi hit a problem on this step and is working on a fix.";

const FOUNDER_LINES: ReadonlySet<string> = new Set([
  ...Object.values(COPY),
  BUILD_OUT_OF_CREDITS,
  BUILD_NO_CREDITS_TO_START,
  BUILD_STAGE_RETRYING,
  SITE_DATABASE_WAITING,
  SITE_DATABASE_SLOW,
  SITE_PUBLISH_PLATFORM_RETRY,
]);

export function isFounderBuildLine(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  return !!t && (FOUNDER_LINES.has(t) || authoredFounderCopy(t) === t);
}
