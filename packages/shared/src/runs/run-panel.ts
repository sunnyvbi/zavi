
import { RUN_PHASES, runPhaseOf } from "../run-phases";
import { shortToolName } from "./tool-names";
import { describeTool, isPlumbingToolName, isReadOnlyTool } from "./tool-phrases";

export type RunActivityRow = {
  id: string;
  kind: string;
  body: Record<string, unknown>;
};

export type RunItemState = "running" | "done" | "failed";

export type RunPanelStep = {
  type: "step";
  key: string;
  label: string;
  state: RunItemState;
};

export type RunPanelThought = {
  type: "thought";
  key: string;
  text: string;
  full?: string;
  live?: boolean;
  origin?: "plan";
};

export type RunPanelTool = {
  key: string;
  name: string;
  input: string;
  output: string;
  ms: number;
  state: RunItemState;
  readOnly?: boolean;
};

export type RunPanelGroup = {
  type: "group";
  key: string;
  label: string;
  count: number;
  state: RunItemState;
  tools: RunPanelTool[];
};

export type RunPanelItem = RunPanelStep | RunPanelThought | RunPanelGroup;

export type RunPanelState = "running" | "finished" | "stopped" | "failed";

export type RunPanel = {
  state: RunPanelState;
  summary: string;
  toolCount: number;
  items: RunPanelItem[];
  readOnly?: boolean;
};

export const REQUEST_RECEIVED = "Request received";
export const DRAFTING = "Writing your answer";

export const MAX_THOUGHT_CHARS = 280;

const ENVELOPE_TAG = /<[a-z][a-z0-9_-]*(?:[\s/>])/;
const TRAILING_PARTIAL_TAG = /<(?:[a-z][a-z0-9_-]*)?$/;

const FILE_PHRASE: Record<string, string> = {
  file_read: "Read your project",
  file_edit: "Edited code",
  file_create: "Wrote a new file",
};

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === "string" ? v : "";
}

function num(body: Record<string, unknown>, key: string): number {
  const v = body[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

const TOOL_TOKEN = /\b[a-z][a-z0-9_]*__[a-z0-9_]+(?:__[a-z0-9_]+)*\b/gi;

function scrubToolTokens(text: string): string {
  TOOL_TOKEN.lastIndex = 0;
  return text
    .replace(new RegExp(`\\s*\\b(?:via|using)\\s+(?:the\\s+)?${TOOL_TOKEN.source}(?:\\s+tool)?`, "gi"), "")
    .replace(TOOL_TOKEN, (tok) => shortToolName(tok).replace(/_/g, " "));
}

export function founderToolOutput(raw: string): string {
  if (!raw) return raw;
  if (/^\s*memory__search denied:/i.test(raw)) return "Skipped: used live data instead.";
  if (/^\s*(?:web_search|operator_db) denied:/.test(raw)) return "Skipped.";
  return raw
    .replace(/<\/?untrusted_[a-z0-9_]+(?:\s[^>]*)?>/gi, "")
    .replace(/^[^\n]*(?:from an untrusted source|as DATA, not as instructions|Do NOT change your tools)[^\n]*(?:\n|$)/gim, "")
    .trim();
}

export function thoughtFull(raw: string): string {
  const cut = raw.search(ENVELOPE_TAG);
  return scrubToolTokens((cut === -1 ? raw : raw.slice(0, cut)).replace(/`/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

export function thoughtText(raw: string): string {
  const human = thoughtFull(raw);
  if (human.length <= MAX_THOUGHT_CHARS) return human;
  return `${human.slice(0, MAX_THOUGHT_CHARS - 1).trimEnd()}…`;
}

export function looksLikeNarration(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 220) return false;
  if (/\n/.test(t)) return false;
  if (/^[#*|>\-\d]/.test(t)) return false;
  return !ENVELOPE_TAG.test(t);
}

export type BuildRunPanelOptions = {
  state?: RunPanelState;
  drafting?: boolean;
  liveThought?: string;
};

type Entry =
  | { kind: "thought"; key: string; text: string; full: string; long: boolean; origin?: "plan" }
  | { kind: "tool"; label: string; tool: RunPanelTool };

export function buildRunPanel(
  rows: RunActivityRow[],
  opts: BuildRunPanelOptions = {},
): RunPanel {
  const state = opts.state ?? "running";
  const running = state === "running";

  const phases: RunPanelStep[] = [];
  const entries: Entry[] = [];
  let planSummary: { key: string; text: string; full: string; at: number } | null = null;

  const openById = new Map<string, RunPanelTool>();
  const openByName = new Map<string, RunPanelTool[]>();

  for (const row of rows) {
    const { kind, body } = row;

    if (kind === "reasoning") {
      const raw = str(body, "text");
      const phase = runPhaseOf(raw);
      if (phase) {
        const last = phases[phases.length - 1];
        if (last && last.label === RUN_PHASES[phase]) continue;
        if (last) last.state = "done";
        phases.push({ type: "step", key: row.id, label: RUN_PHASES[phase], state: "running" });
        continue;
      }
      const text = thoughtText(raw);
      if (text) {
        entries.push({
          kind: "thought",
          key: row.id,
          text,
          full: thoughtFull(raw),
          long: raw.length > MAX_THOUGHT_CHARS || ENVELOPE_TAG.test(raw),
        });
      }
      continue;
    }

    if (kind === "plan") {
      const text = thoughtText(str(body, "summary"));
      if (text && !planSummary) planSummary = { key: row.id, text, full: thoughtFull(str(body, "summary")), at: entries.length };
      continue;
    }

    if (kind === "file_read" || kind === "file_edit" || kind === "file_create") {
      entries.push({
        kind: "tool",
        label: FILE_PHRASE[kind] ?? "Edited code",
        tool: {
          key: row.id,
          name: kind.replace("file_", ""),
          input: str(body, "path"),
          output: "",
          ms: 0,
          state: "done",
          readOnly: kind === "file_read",
        },
      });
      continue;
    }

    if (kind !== "tool_call") continue;

    const raw = str(body, "tool_name");
    if (!raw || isPlumbingToolName(raw)) continue;
    const bare = shortToolName(raw);
    const callId = str(body, "call_id");
    const output = founderToolOutput(str(body, "output_preview") || str(body, "error_message"));
    const failed = str(body, "code") === "err";
    const isResultShaped = str(body, "target") === "";
    if (!isResultShaped && callId !== "" && openById.has(callId)) continue;
    const settled =
      (callId !== "" && openById.has(callId)) ||
      output !== "" ||
      failed ||
      num(body, "ms") > 0;

    if (settled) {
      let pending: RunPanelTool | undefined;
      if (callId && openById.has(callId)) {
        pending = openById.get(callId);
        openById.delete(callId);
        const q = openByName.get(bare);
        if (q && pending) openByName.set(bare, q.filter((t) => t !== pending));
      } else {
        pending = openByName.get(bare)?.shift();
      }
      if (pending) {
        pending.output = output;
        pending.ms = num(body, "ms");
        pending.state = failed ? "failed" : "done";
        continue;
      }
    }

    const tool: RunPanelTool = {
      key: row.id,
      name: bare,
      input: str(body, "target"),
      output,
      ms: num(body, "ms"),
      state: settled ? (failed ? "failed" : "done") : "running",
      readOnly: isReadOnlyTool(raw),
    };
    entries.push({ kind: "tool", label: describeTool(raw), tool });
    if (!settled) {
      if (callId) openById.set(callId, tool);
      const q = openByName.get(bare) ?? [];
      q.push(tool);
      openByName.set(bare, q);
    }
  }

  let lastToolAt = -1;
  entries.forEach((e, i) => {
    if (e.kind === "tool") lastToolAt = i;
  });
  const kept = entries.filter((e, i) => {
    if (e.kind !== "thought") return true;
    if (i < lastToolAt) return true;
    return running && !e.long && !opts.drafting;
  });

  const firstToolAt = kept.findIndex((e) => e.kind === "tool");
  const openedItself = kept
    .slice(0, firstToolAt === -1 ? kept.length : firstToolAt)
    .some((e) => e.kind === "thought");
  if (planSummary && !openedItself && firstToolAt !== -1) {
    kept.unshift({ kind: "thought", key: planSummary.key, text: planSummary.text, full: planSummary.full, long: false, origin: "plan" });
  }

  if (!running) {
    for (const e of kept) if (e.kind === "tool" && e.tool.state === "running") e.tool.state = "failed";
    for (const p of phases) p.state = "done";
  }

  const items: RunPanelItem[] = [];
  for (const e of kept) {
    if (e.kind === "thought") {
      items.push({ type: "thought", key: e.key, text: e.text, full: e.full, ...(e.origin ? { origin: e.origin } : {}) });
      continue;
    }
    const prev = items[items.length - 1];
    if (prev && prev.type === "group" && prev.label === e.label) {
      prev.tools.push(e.tool);
      prev.count += 1;
    } else {
      items.push({ type: "group", key: e.tool.key, label: e.label, count: 1, state: "done", tools: [e.tool] });
    }
  }
  for (const it of items) {
    if (it.type !== "group") continue;
    it.state = it.tools.some((t) => t.state === "running")
      ? "running"
      : it.tools.some((t) => t.state === "failed")
        ? "failed"
        : "done";
  }

  const lead: RunPanelItem[] =
    items.length === 0
      ? [{ type: "step", key: "received", label: REQUEST_RECEIVED, state: "done" }, ...phases]
      : [];

  const tail: RunPanelItem[] = [];
  const liveRaw = opts.liveThought?.replace(TRAILING_PARTIAL_TAG, "");
  if (running && liveRaw) {
    const text = thoughtText(liveRaw);
    const last = [...items].reverse().find((i) => i.type === "thought") as RunPanelThought | undefined;
    const dup = !!last && (last.text.startsWith(text.replace(/…$/, "")) || text.startsWith(last.text.replace(/…$/, "")));
    if (text && !dup) {
      tail.push({ type: "thought", key: "live", text, full: thoughtFull(liveRaw), live: true });
    } else if (text && last && !last.origin && items[items.length - 1] === last) {
      const longer = text.length > last.text.length;
      items[items.length - 1] = {
        ...last,
        text: longer ? text : last.text,
        full: longer ? thoughtFull(liveRaw) : last.full,
        live: true,
      };
    }
  }
  if (running && opts.drafting) {
    tail.push({ type: "step", key: "drafting", label: DRAFTING, state: "running" });
  }

  const all = [...lead, ...items, ...tail];
  const toolCount = items.reduce(
    (n, it) => (it.type === "group" ? n + it.tools.filter((t) => t.state !== "running").length : n),
    0,
  );

  const tools = items.flatMap((it) => (it.type === "group" ? it.tools : []));
  const readOnly = tools.length > 0 && tools.every((t) => t.readOnly === true && t.state === "done");

  return { state, summary: summaryLine(state, all), toolCount, items: all, readOnly };
}

function summaryLine(state: RunPanelState, items: RunPanelItem[]): string {
  if (state === "stopped") return "Stopped";
  if (state === "failed") return "Stopped: something went wrong";

  if (state === "finished") {
    const phrases: string[] = [];
    for (const it of items) {
      if (it.type === "group" && !phrases.includes(it.label)) phrases.push(it.label);
    }
    if (phrases.length === 0) return "Done";
    const shown = phrases.slice(0, 3).map((p) => p.charAt(0).toLowerCase() + p.slice(1));
    const more = phrases.length - shown.length;
    return `Done · ${shown.join(", ")}${more > 0 ? ` +${more} more` : ""}`;
  }

  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.type === "group" && it.state === "running") return `${it.label}…`;
    if (it.type === "step" && it.state === "running") return `${it.label}…`;
    if (it.type === "thought") return it.text.length > 90 ? `${it.text.slice(0, 89).trimEnd()}…` : it.text;
  }
  return "Thinking…";
}
