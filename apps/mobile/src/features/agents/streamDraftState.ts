import {
  DRAFTING,
  buildRunPanel,
  looksLikeNarration,
  thoughtText,
  type RunPanel,
  type RunPanelItem,
  type RunPanelThought,
} from "@zavi/shared";
import { streamDraftPreview } from "./streamDraftPreview";

export type StreamDraftRow = {
  seq: number | string;
  text?: string | null;
  status?: string | null;
  updated_at?: string | null;
};

export type StreamDraftAccum = {
  runId: string | null;
  text: string;
  status: string;
  lastSeq: number;
  lastAt: number;
};

export const EMPTY_DRAFT: StreamDraftAccum = {
  runId: null,
  text: "",
  status: "",
  lastSeq: -1,
  lastAt: Number.NEGATIVE_INFINITY,
};

export function applyStreamDraftUpdate(prev: StreamDraftAccum, runId: string, row: StreamDraftRow): StreamDraftAccum {
  const seq = typeof row.seq === "string" ? Number(row.seq) : row.seq;
  if (!Number.isFinite(seq)) return prev;
  const at = row.updated_at ? Date.parse(row.updated_at) : Number.NaN;
  const base = prev.runId === runId ? prev : EMPTY_DRAFT;
  const byTime = Number.isFinite(at) && Number.isFinite(base.lastAt) && at !== base.lastAt;
  if (!(byTime ? at > base.lastAt : seq > base.lastSeq)) return prev;
  return {
    runId,
    text: row.text ?? "",
    status: row.status ?? "streaming",
    lastSeq: seq,
    lastAt: Number.isFinite(at) ? at : base.lastAt,
  };
}

export function isDraftLive(status: string, replied: boolean): boolean {
  return (status === "streaming" || status === "complete") && !replied;
}

export type DraftSplit = { narration: string; answer: string };

const NOTHING: DraftSplit = { narration: "", answer: "" };

export function splitStreamDraft(text: string, status: string): DraftSplit {
  if (!isDraftLive(status, false)) return NOTHING;
  const preview = streamDraftPreview(text);
  if (!preview) return NOTHING;
  return status === "streaming" && looksLikeNarration(preview)
    ? { narration: preview, answer: "" }
    : { narration: "", answer: preview };
}

export function withLiveRun(
  panel: RunPanel | undefined,
  live: { thought: string; drafting: boolean },
): RunPanel | undefined {
  const text = live.thought ? thoughtText(live.thought) : "";
  if (!text && !live.drafting) return panel;
  const base = panel ?? buildRunPanel([]);
  if (base.state !== "running") return panel;

  const tail: RunPanelItem[] = [];
  if (text) {
    const last = [...base.items].reverse().find((i): i is RunPanelThought => i.type === "thought");
    const dup =
      !!last && (last.text.startsWith(text.replace(/…$/, "")) || text.startsWith(last.text.replace(/…$/, "")));
    if (!dup) tail.push({ type: "thought", key: "live", text, live: true });
  }
  if (live.drafting) tail.push({ type: "step", key: "drafting", label: DRAFTING, state: "running" });
  if (tail.length === 0) return panel;

  const end = tail[tail.length - 1];
  const summary =
    end.type === "step"
      ? `${end.label}…`
      : end.type === "thought"
        ? end.text.length > 90
          ? `${end.text.slice(0, 89).trimEnd()}…`
          : end.text
        : base.summary;
  return { ...base, items: [...base.items, ...tail], summary };
}

export function heldAnswerFor(input: {
  runStatus: string | null | undefined;
  last: { runId: string; text: string } | null;
  runId: string;
  replied: boolean;
}): string | null {
  if (input.replied || input.runStatus !== "success") return null;
  return input.last && input.last.runId === input.runId && input.last.text ? input.last.text : null;
}
