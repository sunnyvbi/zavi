import { TOTALS_BYTE_BUDGET } from "./totals";

export type WasteSpec = {
  labelFields: readonly string[];
  spendField: string;
  conversionFields: readonly string[];
  outcomeLabel: string;
  window: string;
  entity: string;
  complete: boolean;
  top?: number;
  currency: string;
  excludeWhen?: { field: string; values: readonly string[]; label: string };
  secondaryField?: { field: string; label: string };
};

export type Waste = {
  scope: string;
  lines: { label: string; spend: number }[];
  lines_total: number;
  spend_total: number;
  complete: boolean;
  excluded_total?: number;
  secondary_total?: number;
};

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number): number => Math.round(n * 100) / 100;

export function buildWaste(rows: readonly unknown[], spec: WasteSpec): Waste | undefined {
  const top = spec.top ?? 3;
  const present = (f: string) =>
    rows.some((r) => r && typeof r === "object" && f in (r as Record<string, unknown>));
  if (!spec.conversionFields.every(present)) return undefined;
  const found: { label: string; spend: number }[] = [];
  let excluded = 0;
  let secondary = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const spend = num(r[spec.spendField]);
    if (spend <= 0) continue;
    if (spec.conversionFields.some((f) => num(r[f]) > 0)) continue;
    const ex = spec.excludeWhen;
    if (ex && ex.values.includes(String(r[ex.field]))) {
      excluded += 1;
      continue;
    }
    if (spec.secondaryField && num(r[spec.secondaryField.field]) > 0) secondary += 1;
    let label = "";
    for (const f of spec.labelFields) {
      const v = r[f];
      if (typeof v === "string" && v.trim()) {
        label = v.trim();
        break;
      }
    }
    found.push({ label, spend });
  }
  if (found.length === 0) return undefined;
  found.sort((a, b) => b.spend - a.spend);

  const spend_total = round2(found.reduce((a, r) => a + r.spend, 0));
  const lines = found
    .filter((r) => r.label)
    .slice(0, top)
    .map((r) => ({
      label: r.label.replace(/\\+[nrt]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48),
      spend: round2(r.spend),
    }));
  const waste: Waste = {
    scope: `${found.length} ${spec.entity} spent ${spend_total} ${spec.currency} with no ${spec.outcomeLabel} in ${spec.window}${spec.complete ? "" : " (partial pull)"}. Zero is not proof of waste: check tracking and lag first.${excluded > 0 && spec.excludeWhen ? ` ${excluded} more left out: ${spec.excludeWhen.label}.` : ""}${secondary > 0 && spec.secondaryField ? ` ${secondary} of them logged ${spec.secondaryField.label}: still waste unless the founder counts that action.` : ""}`,
    lines,
    lines_total: found.length,
    spend_total,
    complete: spec.complete,
    ...(excluded > 0 ? { excluded_total: excluded } : {}),
    ...(secondary > 0 ? { secondary_total: secondary } : {}),
  };

  while (wasteBytes(waste) > TOTALS_BYTE_BUDGET && waste.lines.length > 0) {
    waste.lines.pop();
  }
  return waste;
}

export function wasteBytes(waste: Waste): number {
  return Buffer.byteLength(JSON.stringify(waste), "utf-8");
}
