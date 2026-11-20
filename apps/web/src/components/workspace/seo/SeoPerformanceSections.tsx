
import { AgentReadiness } from "./AgentReadiness";
import { CategoryDials } from "./CategoryDials";
import { DeliveryGapLine } from "./DeliveryGap";
import { FieldVitals } from "./FieldVitals";
import { Opportunities } from "./Opportunities";
import { humanizeReason, shortUrl } from "./format";
import { SeoNote, SeoSectionLabel } from "./ui";
import type { LabPage, SeoLabReport, SeoPerformanceReport } from "./types";

export function firstPage(lab: SeoLabReport | null | undefined): LabPage | null {
  if (!lab || lab.state !== "ok") return null;
  const pages = Array.isArray(lab.pages) ? lab.pages : [];
  return pages[0] ?? null;
}

function labHeader(page: LabPage | null) {
  const bits: string[] = [];
  const url = page?.final_url ?? page?.requested_url;
  if (url) bits.push(shortUrl(url));
  if (page?.strategy === "mobile") bits.push("simulated phone");
  else if (page?.strategy === "desktop") bits.push("simulated desktop");
  return bits.length > 0 ? ` · ${bits.join(" · ")}` : "";
}

export function LabRun({
  lab,
  warming = false,
}: {
  lab: SeoLabReport | null | undefined;
  warming?: boolean;
}) {
  if (warming && !firstPage(lab)) {
    return (
      <section>
        <SeoSectionLabel>Lab run</SeoSectionLabel>
        <SeoNote busy title="Running the page test now">
          <p>
            Google is loading your pages in a real browser and grading what it
            sees. This takes a few minutes the first time.
          </p>
          <p>
            The scores appear here once it finishes. Reopen this in a few minutes
            to see them.
          </p>
        </SeoNote>
      </section>
    );
  }

  if (!lab) return null;

  if (lab.state === "not_configured") {
    return (
      <section>
        <SeoSectionLabel>Lab run</SeoSectionLabel>
        <SeoNote title="Not running the speed test yet">
          <p>
            Zavi needs a Google API key on file before it can run Google&apos;s own
            page test against your site. This is a setup step on our side, not a
            problem with the page.
          </p>
        </SeoNote>
      </section>
    );
  }

  if (lab.state === "unavailable") {
    const why = humanizeReason(lab.reason);
    return (
      <section>
        <SeoSectionLabel>Lab run</SeoSectionLabel>
        <SeoNote title="Couldn't run the page test this time">
          <p>
            Google didn&apos;t return a result, so there is nothing measured to show.
            The next run tries again.
          </p>
          {why ? <p>Reported: {why}.</p> : null}
        </SeoNote>
      </section>
    );
  }

  const page = firstPage(lab);
  const categories = page?.categories ?? [];
  const hasDials = categories.some((c) => c.display_mode !== "fraction");

  if (!page) {
    return (
      <section>
        <SeoSectionLabel>Lab run</SeoSectionLabel>
        <SeoNote title="No page test came back">
          <p>
            The run finished without a measured page. Nothing here is a score. The
            next run should fill it in.
          </p>
        </SeoNote>
      </section>
    );
  }

  return (
      <section>
        <SeoSectionLabel>Lab run{labHeader(page)}</SeoSectionLabel>
        {hasDials ? (
          <CategoryDials categories={categories} />
        ) : (
          <p className="text-[13px] leading-[1.5] text-inkMuted">
            Google returned no category scores for this page.
          </p>
        )}
        {lab.truncated ? (
          <p className="mt-2 text-[12px] leading-[1.5] text-inkMuted">
            Showing the first page tested. The run checked more than are listed here.
          </p>
        ) : null}
        {}
        {warming ? (
          <p className="mt-2 text-[12px] leading-[1.5] text-inkMuted">
            Running the test again now. These are the scores from the last run.
          </p>
        ) : null}
      </section>
  );
}

export function SeoPerformanceSections({
  report,
}: {
  report: SeoPerformanceReport | null | undefined;
}) {
  if (!report) return null;
  const warming = report.warming === true;
  if (
    !warming &&
    !report.field &&
    !report.lab &&
    !report.agent_readiness &&
    !report.delivery_gap
  )
    return null;
  return (
    <div className="flex flex-col gap-5">
      <FieldVitals field={report.field} warming={warming} />
      {}
      <DeliveryGapLine gap={report.delivery_gap} />
      <LabRun lab={report.lab} warming={warming} />
      {}
      <AgentReadiness readiness={report.agent_readiness} />
      <Opportunities opportunities={firstPage(report.lab)?.opportunities} />
    </div>
  );
}
