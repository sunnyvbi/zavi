import { isLaneError } from "./derive";
import type { DeltaOr, GeoChannelPayload, GeoEngine, PromptCell, VisibilityPanel } from "./types";

export type AnswerState = "cited" | "mentioned" | "absent" | "none";
export type TileDelta = { pct: number; up: boolean } | null;
export type TileChange = { delta: TileDelta; since: string; note: string | null };
type HistoryKey = "mention_rate" | "citation_rate" | "share_of_voice";
export type GeoVisibilityModel = {
  brand: string;
  promptsTracked: number;
  measured: null | {
    promptsAsked: number;
    promptsMentioned: number;
    citations: number;
    share: number | null;
    deltas: { mentions: TileChange; citations: TileChange; share: TileChange };
    engines: { id: GeoEngine; label: string }[];
    prompts: { id: string; text: string; cells: AnswerState[] }[];
    voices: { name: string; share: number; own: boolean }[];
    voiceNote: string | null;
  };
};

export const ANSWER_WORD: Record<AnswerState, string> = { cited: "Cited", mentioned: "Mentioned", absent: "Not mentioned", none: "–" };

function answerState(cell: PromptCell | undefined): AnswerState {
  if (!cell || cell.collected === 0) return "none";
  if (cell.cited > 0) return "cited";
  return cell.mentioned > 0 ? "mentioned" : "absent";
}

const points = (pp: number): TileDelta => ({ pct: Number(Math.abs(pp).toFixed(1)), up: pp > 0 });
const WINDOW = "vs the period before";
const CHECK = "vs the check before";

function tileChange(d: DeltaOr | undefined, history: VisibilityPanel["history"] | undefined, key: HistoryKey, label?: string): TileChange {
  const note = (text: string) => label ? `${label}: ${text}` : text;
  if (d && !("unavailable" in d)) {
    return d.significant && d.delta_pp !== 0
      ? { delta: points(d.delta_pp), since: WINDOW, note: null }
      : { delta: null, since: WINDOW, note: note(`No real change ${WINDOW}`) };
  }
  const checks = history ?? [];
  const latest = checks[checks.length - 1];
  const before = checks[checks.length - 2];
  const baselineMoved = !latest || latest.prompt_set_changed || (key === "share_of_voice" && latest.rival_set_changed);
  const now = latest?.[key];
  const then = before?.[key];
  if (baselineMoved || typeof now !== "number" || typeof then !== "number") return { delta: null, since: CHECK, note: note("Nothing to compare with yet") };
  const pp = Math.round((now - then) * 1000) / 10;
  return pp === 0 ? { delta: null, since: CHECK, note: note(`No change ${CHECK}`) } : { delta: points(pp), since: CHECK, note: null };
}

const VOICE_NOTE: Record<string, string> = {
  no_rivals: "No rivals are listed yet, so there is no share to compare.",
  no_mentions: "No answer named you or a rival in this window, so there is no share to split.",
};

export function geoVisibilityModel(payload: unknown): GeoVisibilityModel | null {
  const lane = (payload as GeoChannelPayload | null)?.visibility;
  if (!lane || isLaneError(lane)) return null;
  const v = lane as VisibilityPanel;
  const brand = v.config?.brand?.trim() || "your brand";
  const promptsTracked = v.config?.prompts_active ?? 0;
  const m = v.metrics;
  const grid = m?.prompt_grid;
  if (!m || !grid) return { brand, promptsTracked, measured: null };
  const planned = new Set((m.prompt_coverage ?? []).filter((c) => c.planned > 0).map((c) => c.engine));
  const asked = (v.config.engines ?? []).filter((e) => planned.has(e.id) || (grid.totals.engines[e.id]?.collected ?? 0) > 0);
  const answered = grid.rows.filter((r) => r.all.collected > 0);
  const sov = m.share_of_voice;
  const voices = sov.state === "ok" && sov.share !== null
    ? [{ name: brand, share: sov.share, own: true }, ...sov.rivals.flatMap((r) => (r.share === null ? [] : [{ name: r.name, share: r.share, own: false }]))].sort((a, b) => b.share - a.share)
    : [];
  return {
    brand,
    promptsTracked,
    measured: {
      promptsAsked: answered.length,
      promptsMentioned: answered.filter((r) => r.all.mentioned > 0).length,
      citations: m.citation_rate.numerator,
      share: sov.state === "ok" ? sov.share : null,
      deltas: {
        mentions: tileChange(v.deltas?.mention_rate, v.history, "mention_rate", "Mention rate"),
        citations: tileChange(v.deltas?.citation_rate, v.history, "citation_rate", "Citation rate"),
        share: tileChange(v.deltas?.share_of_voice, v.history, "share_of_voice"),
      },
      engines: asked,
      prompts: grid.rows.map((r) => ({ id: r.prompt_id, text: r.prompt_text, cells: asked.map((e) => answerState(r.engines[e.id])) })),
      voices,
      voiceNote: voices.length ? null : (VOICE_NOTE[sov.state] ?? null),
    },
  };
}

export function geoHeadline(model: GeoVisibilityModel): string | null {
  const m = model.measured;
  if (!m || m.promptsAsked === 0) return null;
  const lead = `AI tools mention ${model.brand} in ${m.promptsMentioned} of your ${m.promptsAsked} tracked prompts`;
  if (m.promptsMentioned === 0) return `AI tools do not mention ${model.brand} in any of your ${m.promptsAsked} tracked prompts yet.`;
  if (m.promptsMentioned === m.promptsAsked) return `${lead}, so people asking hear about you every time.`;
  return m.promptsMentioned * 2 < m.promptsAsked ? `${lead}, so most people asking still hear about others.` : `${lead}, so most people asking hear about you.`;
}

export function sharePercent(share: number): string {
  const pct = share * 100;
  const edge = (pct > 0 && pct < 1) || (pct > 99 && pct < 100);
  return `${edge ? pct.toFixed(1) : Math.round(pct)}%`;
}
