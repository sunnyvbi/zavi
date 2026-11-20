
import {
  BAND_WORD,
  CORE_WEB_VITALS,
  VITAL_ORDER,
  VITAL_THRESHOLDS,
  fmtCruxDate,
  fmtVital,
  humanizeReason,
  shortUrl,
  vitalBand,
  type Band,
} from "./format";
import { BAND_TEXT, SeoChip, SeoNote, SeoSectionLabel } from "./ui";
import type { CruxMetricKey, SeoFieldReport } from "./types";

function Vital({ metricKey, value }: { metricKey: CruxMetricKey; value: number }) {
  const t = VITAL_THRESHOLDS[metricKey];
  const band = vitalBand(metricKey, value);
  const goodPct = (t.good / t.axisMax) * 100;
  const warnPct = ((t.poor - t.good) / t.axisMax) * 100;
  const failPct = Math.max(0, 100 - goodPct - warnPct);
  const markerPct = Math.max(0, Math.min(100, (value / t.axisMax) * 100));

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] text-inkMuted">{t.label}</span>
          <SeoChip>{t.acronym}</SeoChip>
        </span>
        <span
          className={`shrink-0 text-[16px] font-semibold tabular-nums ${BAND_TEXT[band]}`}
        >
          {fmtVital(metricKey, value)}
          {}
          <span className="sr-only">, {BAND_WORD[band]}</span>
        </span>
      </div>
      <div aria-hidden className="relative mt-1.5 h-1.5">
        <div className="flex h-full gap-[2px] overflow-hidden rounded-full">
          <span className="h-full rounded-full bg-success/80" style={{ width: `${goodPct}%` }} />
          <span className="h-full rounded-full bg-warn/80" style={{ width: `${warnPct}%` }} />
          <span className="h-full rounded-full bg-danger/80" style={{ width: `${failPct}%` }} />
        </div>
        <span
          className="absolute top-[-3px] h-3 w-[2px] rounded-sm bg-ink"
          style={{ left: `calc(${markerPct}% - 1px)` }}
        />
      </div>
      <div
        aria-hidden
        className="mt-1 flex justify-between text-[11px] tabular-nums text-inkMuted"
      >
        <span>0</span>
        <span>{fmtVital(metricKey, t.good)} good</span>
        <span>{fmtVital(metricKey, t.poor)}</span>
      </div>
    </div>
  );
}

function coreVerdict(
  metrics: Partial<Record<CruxMetricKey, { p75?: number } | null>>,
): Band | null {
  const bands: Band[] = [];
  for (const key of CORE_WEB_VITALS) {
    const p75 = metrics[key]?.p75;
    if (typeof p75 !== "number" || !Number.isFinite(p75)) return null;
    bands.push(vitalBand(key, p75));
  }
  if (bands.length !== CORE_WEB_VITALS.length) return null;
  if (bands.includes("fail")) return "fail";
  if (bands.includes("warn")) return "warn";
  return "pass";
}

const VERDICT_WORD: Record<Band, string> = {
  pass: "passed",
  warn: "borderline",
  fail: "failed",
};

function measuredVitals(field: SeoFieldReport | null | undefined) {
  if (!field || field.state !== "ok") return [];
  const metrics = field.metrics ?? {};
  return VITAL_ORDER.map((key) => {
    const p75 = metrics[key]?.p75;
    return typeof p75 === "number" && Number.isFinite(p75) ? { key, value: p75 } : null;
  }).filter((v): v is { key: CruxMetricKey; value: number } => v !== null);
}

export function FieldVitals({
  field,
  warming = false,
}: {
  field: SeoFieldReport | null | undefined;
  warming?: boolean;
}) {
  const shown = measuredVitals(field);

  const header = (right?: React.ReactNode, windowText?: string) => (
    <SeoSectionLabel right={right}>
      What real visitors got{windowText ? ` \u00b7 ${windowText}` : ""} <SeoChip>CrUX</SeoChip>
    </SeoSectionLabel>
  );

  if (warming && shown.length === 0) {
    return (
      <section>
        {header()}
        <SeoNote busy title="Measuring your site now">
          <p>
            Zavi is asking Google what real visitors got on your pages. A first
            read takes a few minutes.
          </p>
          <p>
            The numbers appear here once it finishes, reopen this in a few
            minutes to see them.
          </p>
        </SeoNote>
      </section>
    );
  }

  if (!field) return null;

  if (field.state === "not_configured") {
    return (
      <section>
        {header()}
        <SeoNote title="Not reading Google's visitor data yet">
          <p>
            Zavi needs a Google API key on file before it can ask what real Chrome
            users got on your site. Nothing is wrong with the site. This is a
            setup step on our side.
          </p>
        </SeoNote>
      </section>
    );
  }

  if (field.state === "unavailable") {
    const why = humanizeReason(field.reason);
    return (
      <section>
        {header()}
        <SeoNote title="Couldn't reach Google's visitor data this time">
          <p>
            The last run couldn&apos;t get an answer, so there is nothing measured to
            show. The next run tries again.
          </p>
          {why ? <p>Reported: {why}.</p> : null}
        </SeoNote>
      </section>
    );
  }

  if (field.state === "no_data") {
    const tried = (field.tried ?? []).filter(
      (t): t is string => typeof t === "string" && t.trim().length > 0,
    );
    return (
      <section>
        {header()}
        <SeoNote title="Google has not seen enough visitors to measure you yet">
          <p>
            These numbers come from real Chrome users. Google only publishes them
            once a site passes a traffic threshold it does not disclose, and yours
            is below it, so it reports no data rather than a slow score.
          </p>
          <p>
            That is a finding, not a gap: nobody is measuring your speed because
            almost nobody is arriving. The lab run below still shows what a visitor
            would get.
          </p>
          {tried.length > 0 ? (
            <p className="[overflow-wrap:anywhere]">
              Asked about {tried.map((t) => shortUrl(t)).join(" and ")}.
            </p>
          ) : null}
        </SeoNote>
      </section>
    );
  }

  const metrics = field.metrics ?? {};

  if (shown.length === 0) {
    return (
      <section>
        {header()}
        <SeoNote title="Google returned no measurements for this site">
          <p>
            The request went through but came back with nothing to show. Nothing is
            wrong with the site. There is simply no measured visitor data yet.
          </p>
        </SeoNote>
      </section>
    );
  }

  const verdict = coreVerdict(metrics);
  const from = fmtCruxDate(field.collection_period?.firstDate);
  const to = fmtCruxDate(field.collection_period?.lastDate);
  const windowLabel = from && to ? `${from} → ${to}` : "last 28 days";

  return (
    <section>
      {header(
        verdict ? (
          <SeoChip tone={verdict}>Core Web Vitals: {VERDICT_WORD[verdict]}</SeoChip>
        ) : null,
        windowLabel,
      )}
      <div className="grid grid-cols-1 gap-x-5 gap-y-3.5 sm:grid-cols-2">
        {shown.map((v) => (
          <Vital key={v.key} metricKey={v.key} value={v.value} />
        ))}
      </div>
      {field.scope === "origin" ? (
        <p className="mt-2 text-[12px] leading-[1.5] text-inkMuted">
          Measured across your whole site. Google had no separate reading for this
          one page.
        </p>
      ) : null}
      {}
      {warming ? (
        <p className="mt-2 text-[12px] leading-[1.5] text-inkMuted">
          Measuring again now. These are the numbers from the last read.
        </p>
      ) : null}
    </section>
  );
}
