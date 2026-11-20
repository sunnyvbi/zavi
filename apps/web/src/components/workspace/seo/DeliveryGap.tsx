
import { fmtMs } from "./format";
import { SeoChip } from "./ui";
import type { DeliveryGap } from "./types";

const SCOPE_WORD: Record<string, string> = {
  url: "on this page",
  origin: "across your whole site",
};

function stateableMs(n: number | undefined): string | null {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? fmtMs(n) : null;
}

export function DeliveryGapLine({ gap }: { gap: DeliveryGap | undefined }) {
  if (!gap || gap.state !== "diverged") return null;

  const lab = stateableMs(gap.lab_ms);
  const field = stateableMs(gap.field_ms);
  const note =
    typeof gap.note === "string" && gap.note.trim().length > 0 ? gap.note.trim() : null;
  if (!lab && !field && !note) return null;

  const scope = typeof gap.field_scope === "string" ? SCOPE_WORD[gap.field_scope] : undefined;

  return (
    <section>
      {}
      <div className="rounded-xl border border-rule bg-white px-3.5 py-3">
        <p className="text-[13px] font-semibold leading-5 text-ink">
          The lab test and real visitors disagree
        </p>
        {lab || field ? (
          <dl className="mt-1.5 flex flex-col gap-1">
            {lab ? (
              <div className="flex items-baseline justify-between gap-3 text-[13px] leading-[1.5]">
                <dt className="min-w-0 text-inkMuted">
                  Google&apos;s lab test, on a simulated phone
                </dt>
                <dd className="shrink-0 font-semibold tabular-nums text-ink">{lab}</dd>
              </div>
            ) : null}
            {field ? (
              <div className="flex items-baseline justify-between gap-3 text-[13px] leading-[1.5]">
                <dt className="flex min-w-0 flex-wrap items-baseline gap-2 text-inkMuted">
                  <span>What real visitors got{scope ? ` ${scope}` : ""}</span>
                  <SeoChip>CrUX</SeoChip>
                </dt>
                <dd className="shrink-0 font-semibold tabular-nums text-ink">{field}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        {note ? (
          <p className="mt-2 text-[13px] leading-[1.5] text-inkMuted [overflow-wrap:anywhere]">
            {note}
          </p>
        ) : null}
      </div>
    </section>
  );
}
