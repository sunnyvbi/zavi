
import { humanizeId } from "./format";
import { SeoChip, SeoSectionLabel } from "./ui";
import type { AgentCheck, AgentReadiness as AgentReadinessData } from "./types";

type CheckState = "pass" | "fail" | "unknown";

const MARK: Record<CheckState, string> = {
  pass: "✓",
  fail: "✗",
  unknown: "–",
};
const MARK_TONE: Record<CheckState, string> = {
  pass: "text-success",
  fail: "text-danger",
  unknown: "text-inkMuted",
};
const MARK_WORD: Record<CheckState, string> = {
  pass: "passed",
  fail: "failed",
  unknown: "not measured",
};

function checkState(c: AgentCheck): CheckState {
  return c.state === "pass" || c.state === "fail" ? c.state : "unknown";
}

function checkLabel(c: AgentCheck): string {
  return c.label ?? humanizeId(c.id) ?? "Check";
}

const LAYOUT_CHECK_ID = "layout_stable";

function count(n: number | undefined, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

export function AgentReadiness({
  readiness,
}: {
  readiness: AgentReadinessData | null | undefined;
}) {
  const checks = Array.isArray(readiness?.checks) ? readiness!.checks : [];
  if (!readiness || checks.length === 0) return null;

  const measured = checks.filter((c) => checkState(c) !== "unknown");
  const applicable = count(readiness.applicable, measured.length);
  const passed = count(
    readiness.passed,
    measured.filter((c) => checkState(c) === "pass").length,
  );
  const hasLayoutCheck = checks.some((c) => c.id === LAYOUT_CHECK_ID);
  const allPassed = applicable > 0 && passed >= applicable;

  return (
    <section>
      <SeoSectionLabel right={<SeoChip>Zavi&apos;s own check</SeoChip>}>
        Can an AI agent use the site?
      </SeoSectionLabel>
      {}
      <p className="-mt-1 mb-2 text-[12px] leading-[1.5] text-inkMuted">
        Google has no standard for this yet, so this is our own test.
      </p>
      <div className="flex flex-wrap items-start gap-3.5">
        {applicable > 0 ? (
          <div
            className={`flex min-w-[68px] shrink-0 flex-col items-center rounded-xl border px-2.5 py-2 ${
              allPassed ? "border-success bg-successBg" : "border-warn bg-warnBg"
            }`}
          >
            <span
              className={`text-[21px] font-semibold leading-none tabular-nums ${
                allPassed ? "text-success" : "text-warn"
              }`}
            >
              {passed}
            </span>
            <span
              className={`mt-1 text-center text-[11px] leading-[1.25] ${
                allPassed ? "text-success" : "text-warn"
              }`}
            >
              of {applicable} we could check
            </span>
          </div>
        ) : null}
        <ul className="min-w-[180px] flex-1 list-none space-y-1.5">
          {checks.map((c, i) => {
            const s = checkState(c);
            return (
              <li key={c.id ?? i} className="text-[13px] leading-[1.4]">
                <span
                  className={`flex items-baseline gap-2 ${
                    s === "unknown" ? "text-inkMuted" : "text-ink"
                  }`}
                >
                  <span aria-hidden className={`shrink-0 text-[12px] ${MARK_TONE[s]}`}>
                    {MARK[s]}
                  </span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {checkLabel(c)}
                    <span className="sr-only">, {MARK_WORD[s]}</span>
                  </span>
                </span>
                {}
                {c.detail ? (
                  <span className="mt-0.5 block pl-[20px] text-[12px] leading-[1.45] text-inkMuted [overflow-wrap:anywhere]">
                    {c.detail}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
      <p className="mt-2 text-[12px] leading-[1.5] text-inkMuted">
        Zavi works this out from your own site: the pages it read, your crawler
        rules, and how steady the layout is.
        {applicable < checks.length
          ? " Anything it could not measure is left out of the count rather than held against you."
          : ""}
        {hasLayoutCheck
          ? " Layout stability is one of the vitals above too, so fixing it moves both."
          : ""}{" "}
        Google&apos;s own page scores something similar from different
        measurements, so the two numbers are not meant to match, and neither is a
        Search ranking signal.
      </p>
    </section>
  );
}
