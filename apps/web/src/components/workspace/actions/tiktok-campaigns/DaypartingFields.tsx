import { SheetSelect, sheetHint as hint } from "../managed-campaigns/AdsSheet";

export type DeliveryWindow = { start: number; end: number };
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const allDay = "1".repeat(336);
export function deliveryWindows(value: string): DeliveryWindow[][] | null {
  if (!/^[01]{336}$/.test(value)) return null;
  if (!value.includes("1")) value = allDay;
  return DAYS.map((_, day) => {
    const slots = value.slice(day * 48, (day + 1) * 48);
    const windows: DeliveryWindow[] = [];
    for (let i = 0; i < 48; i++) if (slots[i] === "1") {
      const start = i;
      while (i < 48 && slots[i] === "1") i++;
      windows.push({ start, end: i });
    }
    return windows;
  });
}
export function deliveryMask(days: DeliveryWindow[][]): string {
  return days.map(windows => Array.from({ length: 48 }, (_, slot) => windows.some(w => slot >= w.start && slot < w.end) ? "1" : "0").join("")).join("");
}
const time = (slot: number) => `${String(Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`;

export function DaypartingFields({ value, onChange, timezone, disabled }: { value?: string; onChange: (value: string) => void; timezone: string | null; disabled: boolean }) {
  const days = value == null || value === "" ? null : deliveryWindows(value);
  const continuous = days?.every(windows => windows.length === 1 && windows[0].start === 0 && windows[0].end === 48);
  const update = (day: number, windows: DeliveryWindow[]) => {
    if (!days) return;
    const next = days.map((current, i) => i === day ? windows : current);
    if (next.some(windows => windows.length > 0)) onChange(deliveryMask(next));
  };
  const nextWindow = (windows: DeliveryWindow[]) => {
    let start = 0;
    for (const window of windows) {
      if (window.start > start) return { start, end: window.start };
      start = window.end;
    }
    return start < 48 ? { start, end: 48 } : null;
  };
  const totalWindows = days?.reduce((n, windows) => n + windows.length, 0) ?? 0;
  return <fieldset disabled={disabled} className="space-y-3">
    <legend className="font-medium">Delivery hours</legend>
    <p className={hint}>Hours use the ad account time zone: {timezone ?? "Unavailable"}. At least one delivery window is required.</p>
    {!days && <p className={hint}>TikTok did not report readable delivery hours. Choosing hours replaces this setting.</p>}
    {continuous && <p className={hint}>Deliver at any time, every day.</p>}
    <div className="flex flex-wrap gap-3"><button type="button" className="underline" onClick={() => onChange(allDay)}>Use all hours</button><button type="button" className="underline" onClick={() => onChange(deliveryMask(DAYS.map((_, i) => i < 5 ? [{ start: 18, end: 34 }] : [])))}>Use weekdays, 09:00–17:00</button></div>
    {days && !continuous && days.map((windows, day) => <div key={day} className="space-y-2 rounded-lg border border-rule p-3">
      <p className="font-medium">{DAYS[day]}{!windows.length && <span className="font-normal text-inkMuted"> · No delivery</span>}</p>
      {windows.map((window, index) => <div key={index} className="flex flex-wrap items-end gap-2">
        <label className="min-w-24 flex-1 text-sm">From<SheetSelect aria-label={`${DAYS[day]} window ${index + 1} start`} value={window.start} onChange={e => update(day, windows.map((w, i) => i === index ? { ...w, start: Number(e.target.value) } : w))}>{Array.from({ length: window.end }, (_, slot) => <option key={slot} value={slot}>{time(slot)}</option>)}</SheetSelect></label>
        <label className="min-w-24 flex-1 text-sm">Until<SheetSelect aria-label={`${DAYS[day]} window ${index + 1} end`} value={window.end} onChange={e => update(day, windows.map((w, i) => i === index ? { ...w, end: Number(e.target.value) } : w))}>{Array.from({ length: 48 - window.start }, (_, offset) => window.start + offset + 1).map(slot => <option key={slot} value={slot}>{time(slot)}</option>)}</SheetSelect></label>
        <button type="button" className="pb-2 text-sm underline" aria-label={`Remove ${DAYS[day]} window ${index + 1}`} disabled={totalWindows === 1} onClick={() => update(day, windows.filter((_, i) => i !== index))}>Remove</button>
      </div>)}
      <button type="button" className="text-sm underline" disabled={!nextWindow(windows)} onClick={() => { const window = nextWindow(windows); if (window) update(day, [...windows, window]); }}>Add {DAYS[day]} hours</button>
    </div>)}
  </fieldset>;
}
