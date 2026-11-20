
import { dayLabel, fullTimestamp, shortTime } from "@/lib/workspace/dayLabels";

export function DayDivider({
  iso,
  withTime = false,
  spacing = "my-1",
}: {
  iso: string;
  withTime?: boolean;
  spacing?: string;
}) {
  const day = dayLabel(iso);
  const time = withTime ? shortTime(iso) : "";
  const label = day && time ? `${day} ${time}` : day;
  if (!label) return null;
  return (
    <div
      role="separator"
      aria-label={label}
      className={`${spacing} flex items-center justify-center`}
    >
      {}
      <span
        title={fullTimestamp(iso)}
        className="rounded-full bg-[#f9f9f9] px-2.5 py-0.5 text-[11px] font-medium leading-[16.5px] tracking-[0.0645px] text-[#0e0f11]"
      >
        {label}
      </span>
    </div>
  );
}
