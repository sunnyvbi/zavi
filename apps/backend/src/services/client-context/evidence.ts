import type { ClientContext, EvidenceRef } from "./types";

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function usd(value: number | null): string {
  return value === null ? "—" : `$${Math.round(value).toLocaleString("en-US")}`;
}

function count(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

export function buildEvidenceCatalog(context: ClientContext): EvidenceRef[] {
  const out: EvidenceRef[] = [];
  const observedAt = context.generated_at;

  const channels = context.channels;
  if (channels.status !== "not_connected") {
    const window = channels.data.window;
    for (const row of [...channels.data.paid, ...channels.data.organic]) {
      const parts: string[] = [];
      if (row.spend_usd !== null) parts.push(`spend ${usd(row.spend_usd)}`);
      if (row.customers !== null)
        parts.push(`${count(row.customers)} customers`);
      if (row.cac_usd !== null) parts.push(`CAC ${usd(row.cac_usd)}`);
      if (row.roas !== null) parts.push(`ROAS ${row.roas.toFixed(2)}×`);
      if (row.conversion_rate !== null)
        parts.push(`conv. ${pct(row.conversion_rate)}`);
      if (parts.length === 0) continue;
      out.push({
        source: row.source,
        label: `${row.channel} performance`,
        value: parts.join(", "),
        observed_at: channels.source_updated_at ?? observedAt,
        provenance: "connected",
        window: { since: window.since, until: window.until },
      });
    }
  }

  for (const metric of context.analytics.data.metrics) {
    if (metric.value === null) continue;
    const formatted =
      metric.unit === "usd"
        ? usd(metric.value)
        : metric.unit === "ratio"
          ? pct(metric.value)
          : count(metric.value);
    out.push({
      source: metric.source,
      label: metric.label,
      value:
        metric.change !== null
          ? `${formatted} (${metric.change >= 0 ? "+" : ""}${(metric.change * 100).toFixed(1)}% vs prior window)`
          : formatted,
      observed_at: metric.window_end,
      provenance: "connected",
    });
  }

  for (const goal of context.goals.data.goals) {
    if (goal.status !== "active") continue;
    out.push({
      source: "autopilot_goals",
      label: `Goal: ${goal.objective}`,
      value: [
        `${goal.target_metric} ${goal.current_value ?? "?"} → ${goal.target_value}`,
        goal.progress !== null
          ? `${pct(goal.progress)} of the way`
          : "progress unknown",
        goal.due_date ? `due ${goal.due_date}` : null,
      ]
        .filter(Boolean)
        .join(", "),
      observed_at: goal.updated_at,
      provenance: "connected",
    });
  }

  for (const competitor of context.competitors.data.competitors) {
    if (!competitor.positioning) continue;
    out.push({
      source: competitor.source,
      label: `Competitor: ${competitor.name}`,
      value: competitor.positioning,
      observed_at: competitor.observed_at ?? observedAt,
      provenance: "connected",
    });
  }

  return out;
}

export function renderEvidenceCatalog(catalog: EvidenceRef[]): string {
  if (catalog.length === 0)
    return "(no grounded evidence available for this client)";

  const line = (ref: EvidenceRef, i: number) =>
    `E${i + 1} [${ref.source} @ ${ref.observed_at}] ${ref.label}: ${ref.value}`;

  const blocks: string[] = [];
  const connected = catalog
    .map((ref, i) => ({ ref, i }))
    .filter(({ ref }) => ref.provenance === "connected");
  const publics = catalog
    .map((ref, i) => ({ ref, i }))
    .filter(({ ref }) => ref.provenance === "public");
  const asserted = catalog
    .map((ref, i) => ({ ref, i }))
    .filter(({ ref }) => ref.provenance === "model_assertion");

  if (connected.length > 0) {
    blocks.push(
      "MEASURED — from accounts this company connected. Numbers here are real.",
      ...connected.map(({ ref, i }) => line(ref, i)),
    );
  }
  if (publics.length > 0) {
    if (blocks.length > 0) blocks.push("");
    blocks.push(
      "PUBLIC — inferred from public surfaces, NOT from their accounts. Describe " +
        "and recommend from these; never state them as this company's measured results.",
      ...publics.map(({ ref, i }) => line(ref, i)),
    );
  }
  if (asserted.length > 0) {
    if (blocks.length > 0) blocks.push("");
    blocks.push(
      "UNSOURCED — a prior model turn asserted these and nothing corroborated " +
        "them. Treat as a hypothesis to verify, never as evidence.",
      ...asserted.map(({ ref, i }) => line(ref, i)),
    );
  }
  return blocks.join("\n");
}

const MEASURED_SHAPE = /(^|\s)(\$[\d,]+|\d+(\.\d+)?%|\d+(\.\d+)?×)/;

export function assertEvidenceProvenance(catalog: EvidenceRef[]): void {
  const offenders = catalog
    .filter(
      (r) => r.provenance !== "connected" && MEASURED_SHAPE.test(r.value),
    )
    .map((r) => `${r.provenance}/${r.source}: ${r.label}`);
  if (offenders.length > 0) {
    throw new Error(
      `public evidence may not carry measured figures: ${offenders.join("; ")}`,
    );
  }
}

export function resolveEvidenceRefs(
  raw: unknown,
  catalog: EvidenceRef[],
  generatedAt: string,
): EvidenceRef[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const out: EvidenceRef[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (!text) continue;

    const idMatch = /^E(\d+)\b/i.exec(text);
    let resolved: EvidenceRef | null = null;
    if (idMatch) {
      const index = Number(idMatch[1]) - 1;
      if (index >= 0 && index < catalog.length) resolved = catalog[index];
    }
    if (!resolved) {
      const needle = text.toLowerCase();
      resolved =
        catalog.find((ref) => needle.includes(ref.label.toLowerCase())) ??
        catalog.find((ref) => ref.label.toLowerCase().includes(needle)) ??
        null;
    }

    const ref: EvidenceRef = resolved ?? {
      source: "model_assertion",
      label: "Unsourced note",
      value: text.slice(0, 500),
      observed_at: generatedAt,
      provenance: "model_assertion",
    };
    const key = `${ref.source}|${ref.label}|${ref.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }

  return out.slice(0, 12);
}
