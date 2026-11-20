"use client";

import { PLAN_LEAD_HOURS, planLatestDay, wallParts } from "@/lib/workspace/emailPlanApi";
import { DatePicker } from "../ugc/DatePicker";
import { TimePicker } from "./TimePicker";

export const PLAN_FIELD =
  "w-full rounded-[8px] border border-rule bg-white px-3 text-[16px] text-ink outline-none placeholder:text-inkLight focus:border-ink disabled:bg-bone disabled:text-inkMuted sm:text-[14px]";

export function PlanWhenFields({
  zone,
  date,
  time,
  invalid,
  disabled,
  up,
  onDate,
  onTime,
}: {
  zone: string | null;
  date: string;
  time: string;
  invalid?: boolean;
  disabled?: boolean;
  up?: boolean;
  onDate: (v: string) => void;
  onTime: (v: string) => void;
}) {
  return (
    <span className="flex flex-wrap items-center gap-3">
      <DatePicker
        label="Day"
        field="day"
        up={up}
        fieldClass={PLAN_FIELD}
        className="h-11 w-[200px] max-w-full"
        value={date}
        min={zone ? wallParts(new Date(Date.now() + PLAN_LEAD_HOURS * 3_600_000).toISOString(), zone).date : ""}
        max={zone ? planLatestDay(zone) : undefined}
        invalid={invalid}
        disabled={disabled}
        onChange={onDate}
      />
      <TimePicker label="Time" up={up} className="h-11 w-[140px] max-w-full" value={time} disabled={disabled} onChange={onTime} />
    </span>
  );
}
