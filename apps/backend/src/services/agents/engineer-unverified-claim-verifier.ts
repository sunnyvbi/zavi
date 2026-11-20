
import { neutralizeSelfReportedTestClaim } from "@/agents/engineer/neutralize-test-claim";

export const ENGINEER_VERIFY_VALIDATOR_AGENTS: ReadonlySet<string> = new Set([
  "engineer",
]);

const BANNER_MARKER = "<!--engineer-verify-correction-->";

const VERIFY_CLAIM_PATTERNS: readonly RegExp[] = [
  /\b(?:all\s+)?tests?\s+(?:are\s+)?(?:pass(?:ed|ing|es)?|green)\b/i,
  /✅[^.\n]*tests?\b/i,
  /\btests?\s*:\s*\d+\s*\/\s*\d+[^.\n]*\b(?:pass(?:ed|ing|es)?|green)\b/i,
  /\btest\s+suite\s+(?:pass|green|is\s+green)/i,
  /\b(?:i\s+)?(?:verified|confirmed)\b[^.\n]*\b(?:it|the\s+\w+|this|works?|working|pass|fix)/i,
  /\b(?:i\s+)?tested\b[^.\n]*\b(?:it|and|works?|working|pass|confirm)/i,
  /\b(?:fixed|change)\b[^.\n]*\band\s+tested\b/i,
  /\b(?:everything\s+passes|all\s+green)\b/i,
];

export type VerifyStatusLike = "passed" | "failed" | "couldnt_run" | "not_run";

export type EngineerVerifyResult = {
  hedged: boolean;
  text: string;
  matched_phrases: string[];
};

function replyMakesVerifyClaim(reply: string): string[] {
  const matched: string[] = [];
  for (const pat of VERIFY_CLAIM_PATTERNS) {
    const m = reply.match(pat);
    if (m) matched.push(m[0].trim());
  }
  return Array.from(new Set(matched));
}

function buildCorrectionBanner(
  status: VerifyStatusLike,
  hasPr: boolean,
  reason?: string,
): string {
  const detail =
    status === "failed"
      ? "the tests did not pass when I ran them in the sandbox"
      : status === "couldnt_run"
        ? `I couldn't run the tests in the sandbox${reason ? ` (${reason.slice(0, 120)})` : ""}`
        : "I didn't run the tests for this change";
  const advice = hasPr
    ? "The PR is open with your change, but please run your CI or test it locally before relying on it."
    : "Please verify this yourself before relying on it.";
  return [
    `> ⚠️ **Correction:** ${detail}. ${advice}`,
    "",
    BANNER_MARKER,
    "",
    "",
  ].join("\n");
}

function buildStaleDistBanner(pkgRoots: string[]): string {
  const named = pkgRoots.filter((p) => p.length > 0);
  const where =
    named.length > 0 ? named.map((p) => `\`${p}\``).join(", ") : "this repo";
  return [
    `> ⚠️ **Correction:** I changed TypeScript source in ${where} but did NOT regenerate its committed \`dist/\`. If this repo deploys the committed \`dist/\` without a build step, this change won't take effect until \`dist/\` is rebuilt.`,
    "",
    BANNER_MARKER,
    "",
    "",
  ].join("\n");
}

export function verifyEngineerTestClaim(args: {
  reply: string;
  verify?: { status?: unknown; reason?: unknown } | null;
  pr_url?: unknown;
  stale_committed_dist?: ReadonlyArray<{ pkgRoot?: unknown; srcFiles?: unknown }> | null;
  side_effect_kind?: unknown;
}): EngineerVerifyResult {
  const reply = typeof args.reply === "string" ? args.reply : "";

  if (reply.includes(BANNER_MARKER)) {
    return { hedged: false, text: reply, matched_phrases: [] };
  }

  const hasPr = typeof args.pr_url === "string" && args.pr_url.trim().length > 0;
  if (args.side_effect_kind !== "shipped" && !hasPr) {
    return { hedged: false, text: reply, matched_phrases: [] };
  }

  const stale = Array.isArray(args.stale_committed_dist)
    ? args.stale_committed_dist
    : [];
  if (stale.length > 0) {
    const pkgRoots = Array.from(
      new Set(
        stale
          .map((h) =>
            h && typeof h === "object"
              ? (h as { pkgRoot?: unknown }).pkgRoot
              : undefined,
          )
          .filter((p): p is string => typeof p === "string"),
      ),
    );
    return {
      hedged: true,
      text: buildStaleDistBanner(pkgRoots) + reply,
      matched_phrases: ["stale_committed_dist"],
    };
  }

  const rawStatus = args.verify?.status;
  const status: VerifyStatusLike =
    rawStatus === "passed" ||
    rawStatus === "failed" ||
    rawStatus === "couldnt_run" ||
    rawStatus === "not_run"
      ? rawStatus
      : "not_run";

  if (status === "passed") {
    return { hedged: false, text: reply, matched_phrases: [] };
  }

  const matched = replyMakesVerifyClaim(reply);
  if (matched.length === 0) {
    return { hedged: false, text: reply, matched_phrases: [] };
  }

  const reason = typeof args.verify?.reason === "string" ? args.verify.reason : undefined;
  const banner = buildCorrectionBanner(status, hasPr, reason);
  const stripped = neutralizeSelfReportedTestClaim(reply).text;
  return { hedged: true, text: banner + stripped, matched_phrases: matched };
}
