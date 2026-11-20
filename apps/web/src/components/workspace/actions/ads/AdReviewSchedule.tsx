import { CalendarDays } from "lucide-react";
import { formatDate } from "@/lib/formatDate";
import type { AdReviewModel } from "./adReviewModel";

function scheduleDate(value: string | null | undefined): string {
  return value?.match(/^\d{4}-\d{2}-\d{2}(?:T|$)/)?.[0].slice(0, 10) ?? "";
}

export function shownDate(value: string | null | undefined): string {
  const day = scheduleDate(value);
  if (!day) return value ? String(value) : "Not set";
  return formatDate(day, "en-US", "UTC");
}

export function AdReviewSchedule({ model }: { model: AdReviewModel }) {
  const schedule = model.schedule;
  const shown = (value: string | null | undefined) => model.channelSlug === "chatgpt_ads" && value && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString().replace("T", " ").replace(".000Z", " UTC") : shownDate(value);
  if (!schedule?.start && !schedule?.end) return null;
  return <section aria-label="When the ad runs" data-testid="ad-schedule" className="mt-6 rounded-2xl border border-rule bg-creamDeep p-4">
    <h5 className="mb-3 flex items-center gap-2 text-sm font-semibold leading-6 text-ink"><CalendarDays className="size-4 shrink-0 text-inkMuted" aria-hidden />When it runs</h5>
    <dl className="flex flex-wrap gap-x-8 gap-y-3">{[{ label: "Starts", value: schedule?.start }, { label: "Ends", value: schedule?.end }].map(({ label, value }) => <div key={label} data-testid={`ad-schedule-${label.toLowerCase()}`} className="min-w-0 flex-1 basis-32">
      <dt className="text-sm leading-5 text-inkMuted">{label}</dt>
      <dd className={value ? "mt-1 break-words text-ad-body font-medium text-ink" : "mt-1 text-ad-body text-inkMuted"}>{scheduleDate(value) ? <time dateTime={value ?? undefined}>{shown(value)}</time> : shown(value)}</dd>
    </div>)}</dl>
    <p className="mt-3 text-detail leading-5 text-inkMuted">Dates are shown in UTC as part of the proposed change.</p>
  </section>;
}
