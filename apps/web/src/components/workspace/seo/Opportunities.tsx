

import { fmtBytes, fmtMetricSaving, fmtMs, humanizeId, positive } from "./format";
import { SeoChip, SeoSectionLabel } from "./ui";
import type { LabOpportunity, PsiCulprit, PsiMetricSaving } from "./types";

const MAX_ROWS = 8;
const MAX_CULPRITS = 4;

const OWNER_LABEL: Record<string, string> = {
  founder: "No developer needed",
  developer: "Needs a developer",
};

function OwnerMark({ owner }: { owner?: string }) {
  const label = owner ? OWNER_LABEL[owner] : undefined;
  if (!label) return null;
  const founder = owner === "founder";
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-[1px] text-[11px] leading-[1.35] ${
        founder ? "bg-bone font-semibold text-ink" : "border border-rule text-inkMuted"
      }`}
    >
      {label}
    </span>
  );
}

function statedCulprits(o: LabOpportunity): PsiCulprit[] {
  return (Array.isArray(o.culprits) ? o.culprits : []).filter(
    (c) =>
      !!c &&
      ((typeof c.label === "string" && c.label.trim().length > 0) ||
        (typeof c.detail === "string" && c.detail.trim().length > 0)),
  );
}

function culpritWeight(c: PsiCulprit): string | null {
  const wasted = positive(c.wastedBytes);
  if (wasted !== null) return `${fmtBytes(wasted)} unused`;
  const bytes = positive(c.bytes);
  return bytes === null ? null : fmtBytes(bytes);
}

const METRIC_NAME: Record<string, string> = {
  LCP: "Largest paint",
  INP: "Tap response",
  CLS: "Layout shift",
  FCP: "First paint",
  TBT: "Main-thread blocking",
};

function statedSavings(o: LabOpportunity): Array<{ metric: string | null; text: string }> {
  const fromMetrics = (Array.isArray(o.metricSavings) ? o.metricSavings : [])
    .map((m: PsiMetricSaving) => ({ metric: m.metric ?? null, text: fmtMetricSaving(m) }))
    .filter((m): m is { metric: string | null; text: string } => m.text !== null);
  if (fromMetrics.length > 0) return fromMetrics;
  const ms = positive(o.savingsMs);
  return ms === null ? [] : [{ metric: null, text: fmtMs(ms) }];
}

export function Opportunities({
  opportunities,
}: {
  opportunities: LabOpportunity[] | undefined;
}) {
  const rows = (opportunities ?? []).slice(0, MAX_ROWS);
  if (rows.length === 0) return null;

  const anyMultiMetric = rows.some((o) => statedSavings(o).length > 1);

  return (
    <section>
      {}
      <SeoSectionLabel
        right={
          <span className="text-[11px] text-inkMuted">
            Google&apos;s estimate, one fix at a time
          </span>
        }
      >
        Biggest wins on this page
      </SeoSectionLabel>
      <ul className="flex flex-col">
        {rows.map((o, i) => {
          const savings = statedSavings(o);
          const bytes = positive(o.savingsBytes);
          const culprits = statedCulprits(o);
          const shownCulprits = culprits.slice(0, MAX_CULPRITS);
          const hiddenCulprits = culprits.length - shownCulprits.length;
          return (
            <li
              key={o.id ?? i}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-t border-rule py-2 first:border-t-0 first:pt-0"
            >
              <div className="min-w-0">
                <span className="block text-[13px] leading-[1.4] text-ink [overflow-wrap:anywhere]">
                  {o.title ?? humanizeId(o.id) ?? "Improvement"}
                </span>
                {}
                {bytes !== null ? (
                  <span className="mt-0.5 block text-[12px] leading-[1.4] text-inkMuted">
                    {fmtBytes(bytes)} smaller
                  </span>
                ) : null}
                {}
                {shownCulprits.length > 0 ? (
                  <ul className="mt-1.5 flex flex-col gap-2 border-l border-rule pl-2.5">
                    {shownCulprits.map((c, k) => {
                      const weight = culpritWeight(c);
                      return (
                        <li key={`${c.label ?? ""}-${k}`} className="min-w-0">
                          <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
                            {c.label ? (
                              <span className="text-[12px] font-semibold leading-[1.4] text-ink [overflow-wrap:anywhere]">
                                {c.label}
                              </span>
                            ) : null}
                            {weight ? (
                              <span className="text-[12px] leading-[1.4] tabular-nums text-inkMuted">
                                {weight}
                              </span>
                            ) : null}
                            <OwnerMark owner={c.owner} />
                          </span>
                          {}
                          {c.detail ? (
                            <span className="mt-0.5 block text-[12px] leading-[1.45] text-inkMuted [overflow-wrap:anywhere]">
                              {c.detail}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                    {hiddenCulprits > 0 ? (
                      <li className="text-[12px] leading-[1.4] text-inkMuted">
                        {hiddenCulprits} more like {hiddenCulprits === 1 ? "this" : "these"} on
                        this page
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </div>
              <span className="flex shrink-0 flex-col items-end gap-0.5">
                {savings.map((s, j) => (
                  <span key={s.metric ?? j} className="flex items-baseline gap-2">
                    <span className="text-[13px] font-semibold tabular-nums text-ink">
                      {s.text}
                    </span>
                    {s.metric ? (
                      <>
                        <SeoChip>{s.metric}</SeoChip>
                        {}
                        <span className="sr-only">
                          {METRIC_NAME[s.metric] ?? s.metric}
                        </span>
                      </>
                    ) : null}
                  </span>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
      {}
      <p className="mt-2 text-[12px] leading-[1.5] text-inkMuted">
        Each number is Google&apos;s estimate for that one fix on this page, from a
        lab run on a simulated phone, not a gain already banked. The fixes share
        one page load, so they are not meant to be added together.
        {anyMultiMetric
          ? " A fix listing two metrics is that one page load measured twice: the numbers describe the same improvement."
          : ""}
      </p>
    </section>
  );
}
