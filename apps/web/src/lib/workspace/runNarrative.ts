
import type { RunPanel, RunPanelGroup, RunPanelItem, RunPanelThought } from "@zavi/shared";

export type NarrativeSegment = {
  key: string;
  thought?: RunPanelThought;
  groups: RunPanelGroup[];
};

export function narrativeSegments(items: RunPanelItem[]): NarrativeSegment[] {
  const out: NarrativeSegment[] = [];
  for (const it of items) {
    if (it.type === "thought") {
      out.push({ key: it.key, thought: it, groups: [] });
    } else if (it.type === "group") {
      const last = out[out.length - 1];
      if (last) last.groups.push(it);
      else out.push({ key: it.key, groups: [it] });
    }
  }
  return out;
}

export function toolCount(groups: RunPanelGroup[]): number {
  return groups.reduce((n, g) => n + g.count, 0);
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function usedToolsLabel(groups: RunPanelGroup[], durationSec?: number | null): string {
  const n = toolCount(groups);
  const base = `Used ${n} ${n === 1 ? "tool" : "tools"}`;
  return durationSec != null && durationSec >= 1 ? `${base} · ${formatDuration(durationSec)}` : base;
}

export function liveLineText(groups: RunPanelGroup[]): string {
  const running = groups.find((g) => g.state === "running");
  if (running) return `${running.label}…`;
  return toolCount(groups) > 0 ? "Reading the results…" : "Thinking…";
}

export type StepRow = { label: string; count: number; state: RunPanelGroup["state"]; tools: RunPanelGroup["tools"] };

export function stepRows(groups: RunPanelGroup[]): StepRow[] {
  const rows = new Map<string, StepRow>();
  for (const g of groups) {
    const row = rows.get(g.label);
    if (!row) {
      rows.set(g.label, { label: g.label, count: g.count, state: g.state, tools: [...g.tools] });
      continue;
    }
    row.count += g.count;
    row.tools.push(...g.tools);
    if (g.state === "running" || (g.state === "failed" && row.state !== "running")) row.state = g.state;
  }
  return [...rows.values()];
}

export function secondsBetween(from?: string | null, to?: string | null): number | null {
  const a = from ? Date.parse(from) : NaN;
  const b = to ? Date.parse(to) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 1000 : null;
}

export function asSettledPanel(p: RunPanel): RunPanel {
  if (p.state !== "running") return p;
  const story = p.items.filter((i) => i.type !== "step");
  const last = story[story.length - 1];
  const withoutAnswer = last?.type === "thought" && last.origin !== "plan" ? story.slice(0, -1) : story;
  const items = withoutAnswer
    .filter((i) => !(i.type === "group" && i.state === "running"))
    .map((i) => (i.type === "thought" && i.live ? { ...i, live: false } : i));
  return { ...p, state: "finished", items };
}
