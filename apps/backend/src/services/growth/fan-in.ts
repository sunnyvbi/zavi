
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { getGrowthBetOutcomes, type GrowthBetOutcome } from "@/services/growth/action-outcomes";

const GROWTH_NOTE_TYPES = ["ads_channel_perf", "social_approved_drafts"] as const;
const MAX_NOTES_PER_TENANT = 50;
const MAX_FAN_IN_CHARS = 50_000;

const EXCERPT_CHARS_BY_TYPE: Record<string, number> = {
  ads_channel_perf: 1800,
};
const DEFAULT_EXCERPT_CHARS = 240;

export const NO_GROWTH_NOTES =
  "(no prior specialist notes — diagnose from live growth__* tools)";

export type MemoryNoteRow = {
  id: string;
  tenant_id: string;
  note_type: string;
  title: string;
  body_markdown: string;
  tags: string[] | null;
  source: string | null;
  source_ref: string | null;
  created_at: string;
};

export function renderFanInBlock(notes: MemoryNoteRow[]): string | null {
  if (notes.length === 0) return null;

  const byType: Record<string, MemoryNoteRow[]> = {};
  for (const n of notes) {
    if (!byType[n.note_type]) byType[n.note_type] = [];
    byType[n.note_type].push(n);
  }

  const lines: string[] = [
    `## Specialist activity, last 7 days`,
    ``,
    `Pre-summarized server-side by \`growth-lead-daily\` worker.`,
    `Total notes: ${notes.length}.`,
    ``,
  ];

  for (const noteType of Object.keys(byType).sort()) {
    const group = byType[noteType];
    lines.push(`### ${noteType} (${group.length})`);
    lines.push(``);
    const excerptChars = EXCERPT_CHARS_BY_TYPE[noteType] ?? DEFAULT_EXCERPT_CHARS;
    for (const note of group) {
      const isTruncated = note.body_markdown.length > excerptChars;
      const preview = note.body_markdown.slice(0, excerptChars).replace(/\n/g, " ");
      const tagStr = (note.tags ?? []).join(", ");
      lines.push(
        `- **${note.title || "(untitled)"}** \`id=${note.id}\` _(tags: ${tagStr || "—"})_`,
      );
      lines.push(
        `  > ${preview}${isTruncated ? ` [row truncated — open note id=${note.id} for figures]` : ""}`,
      );
    }
    lines.push(``);
  }

  let block = lines.join("\n");

  let workingNotes = [...notes];
  while (block.length > MAX_FAN_IN_CHARS && workingNotes.length > 5) {
    workingNotes.sort((a, b) => a.created_at.localeCompare(b.created_at));
    workingNotes.shift();
    block = renderFanInBlock(workingNotes) ?? "";
  }

  return block;
}

export function renderBetOutcomesBlock(outcomes: GrowthBetOutcome[]): string | null {
  if (outcomes.length === 0) return null;
  const fmtDelta = (label: string, v: number | null): string | null =>
    v == null || Number.isNaN(v) ? null : `${label} ${v > 0 ? "+" : ""}${v}`;
  const lines: string[] = [
    `## Measured outcomes of your past EXECUTED bets`,
    ``,
    `Only bets you proposed AND the founder approved-to-dispatch AND whose`,
    `downstream action has now been MEASURED appear here. Cite these by id/date`,
    `when a new bet builds on a past result — never restate a delta not listed.`,
    ``,
  ];
  for (const o of outcomes) {
    const date = o.bet_emitted_at?.slice(0, 10) ?? "?";
    const claim = (o.bet_claim ?? "(bet)").slice(0, 100);
    const deltas = [fmtDelta("Δspend", o.spend_delta), fmtDelta("Δroas", o.roas_delta)]
      .filter(Boolean)
      .join(", ");
    const measured = o.measured_at ? ` (measured ${o.measured_at.slice(0, 10)})` : "";
    lines.push(
      `- bet \`${o.bet_decision_id}\` from ${date}: ${claim} → ${o.action_class} ${o.decision_outcome}; ${
        deltas || "no numeric delta"
      }${measured}`,
    );
  }
  lines.push(``);
  return lines.join("\n");
}

export async function buildGrowthFanInPayload(
  tenant_id: string,
): Promise<Record<string, unknown>> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("memory_note")
    .select("id, tenant_id, note_type, title, body_markdown, tags, source, source_ref, created_at")
    .in("note_type", GROWTH_NOTE_TYPES as unknown as string[])
    .gte("created_at", sevenDaysAgo)
    .order("created_at", { ascending: false })
    .limit(MAX_NOTES_PER_TENANT);

  if (error) {
    console.warn(
      `[growth-fan-in] memory_note read failed for ${tenant_id} (running tool-first): ${error.message}`,
    );
    return { memory: { growth_fan_in: NO_GROWTH_NOTES }, fan_in_note_ids: [] };
  }

  const notes = (data ?? []) as MemoryNoteRow[];

  let fanInBlock = notes.length > 0 ? renderFanInBlock(notes) ?? NO_GROWTH_NOTES : NO_GROWTH_NOTES;

  try {
    const { bets } = await getGrowthBetOutcomes(tenant_id);
    const outcomesBlock = renderBetOutcomesBlock(bets);
    if (outcomesBlock) {
      fanInBlock = `${fanInBlock}\n\n${outcomesBlock}`;
    }
  } catch (e) {
    console.warn(
      `[growth-fan-in] bet-outcome attribution read failed for ${tenant_id}: ${(e as Error).message}`,
    );
  }

  return {
    memory: {
      growth_fan_in: fanInBlock,
    },
    fan_in_note_ids: notes.map((n) => n.id),
  };
}
