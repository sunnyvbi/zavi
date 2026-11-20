"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Brain, ChevronRight, LoaderCircle } from "lucide-react";
import { memoryApi, resolvePairId, type MemoryApi, type MemoryWriteItem } from "@/lib/memory/writesApi";
import { dropCachedItem, useMemoryWrites, useSeenOnce } from "@/lib/memory/useMemoryWrites";
import { FORGET_NOTES, HIDDEN_MODES, UNDOABLE_MODES, useForgetWithUndo } from "./useForgetWithUndo";
import { NextChevron } from "@/components/ui/NextChevron";
import { memoryUrl } from "@/lib/workspace/tabUrl";

export const smallBtn =
  "inline-flex h-8 shrink-0 cursor-pointer items-center rounded-cta border border-rule bg-white px-2.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 disabled:cursor-default disabled:opacity-60";

const rowBtn =
  "inline-flex h-8 shrink-0 cursor-pointer items-center rounded-full border border-rule bg-creamDeep px-3.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 disabled:cursor-default disabled:opacity-60 relative after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-['']";

const pillBase =
  "inline-flex h-6 items-center gap-1.5 rounded-full border border-rule px-2 text-[12px] font-medium";

export function factCount(n: number, verb: string): string {
  return `${verb} ${n} ${n === 1 ? "fact" : "facts"}`;
}

export function subjectOf(title: string): string | null {
  const i = title.indexOf(":");
  if (i <= 0 || i > 40) return null;
  return title.slice(0, i).trim().toLowerCase() || null;
}

export function pillLabel(items: MemoryWriteItem[], kept: number): string {
  if (items.some((i) => i.kind === "conflict")) return "Two values on record";
  if (items.every((i) => i.kind === "updated")) {
    const subject = items.length === 1 ? subjectOf(items[0]!.title) : null;
    return subject ? `Updated ${subject}` : factCount(items.length, "Updated");
  }
  return kept > 0 ? factCount(kept, "Remembered") : factCount(items.length, "Forgot");
}

type RowState = "busy" | "undone" | "kept" | "error";

export function RememberedPill({
  runId,
  api = memoryApi,
  enabled = true,
  defaultOpen = false,
  caption,
}: {
  runId: string;
  caption?: string;
  api?: MemoryApi;
  enabled?: boolean;
  defaultOpen?: boolean;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const seen = useSeenOnce(slot);
  const writes = useMemoryWrites(runId, api, enabled && seen);
  const showing = writes.status === "pending" || (writes.status === "done" && writes.items.length > 0);
  return (
    <div ref={slot} data-testid="remembered-pill-slot">
      {showing && caption ? <p className="mt-2 text-[13px] text-inkMuted">{caption}</p> : null}
      {writes.status === "pending" ? (
        <div className="mt-2">
          <span role="status" className={`${pillBase} bg-transparent text-inkMuted`}>
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Saving to memory…
          </span>
        </div>
      ) : writes.status === "done" && writes.items.length > 0 ? (
        <PillBody runId={runId} items={writes.items} api={api} defaultOpen={defaultOpen} />
      ) : null}
    </div>
  );
}

export function PillBody({
  runId,
  items,
  api,
  defaultOpen = false,
}: {
  runId: string;
  items: MemoryWriteItem[];
  api: MemoryApi;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [keptId, setKeptId] = useState<Record<string, string>>({});
  const { modes, forget, undo } = useForgetWithUndo(api, (id) => dropCachedItem(runId, id));
  const setRow = (id: string, s: RowState | null) =>
    setRows((prev) => {
      const next = { ...prev };
      if (s) next[id] = s;
      else delete next[id];
      return next;
    });

  const visible = items.filter((i) => modes[i.note_id] !== "gone");
  if (visible.length === 0) return null;
  const kept = visible.filter((i) => !HIDDEN_MODES.has(modes[i.note_id] ?? "")).length;
  const label = pillLabel(visible, kept);
  const href = memoryUrl(visible.map((i) => i.note_id));

  const undoUpdate = async (item: MemoryWriteItem) => {
    setRow(item.note_id, "busy");
    try {
      await api.undoUpdate(item.note_id);
      setRow(item.note_id, "undone");
      dropCachedItem(runId, item.note_id);
    } catch {
      setRow(item.note_id, "error");
    }
  };

  const keep = async (item: MemoryWriteItem, noteId: string) => {
    setRow(item.note_id, "busy");
    try {
      const pairId = await resolvePairId(api, item);
      if (!pairId) throw new Error("no open pair");
      await api.keepConflict(pairId, noteId);
      setKeptId((prev) => ({ ...prev, [item.note_id]: noteId }));
      setRow(item.note_id, "kept");
      dropCachedItem(runId, item.note_id);
    } catch {
      setRow(item.note_id, "error");
    }
  };

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`${pillBase} cursor-pointer bg-transparent text-inkMuted transition-colors duration-150 hover:border-ink/25 hover:text-ink aria-expanded:border-ink/25 aria-expanded:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30`}
      >
        <Brain className="h-3 w-3" aria-hidden="true" />
        {label}
        <ChevronRight
          className={`h-3 w-3 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="mt-2 overflow-hidden rounded-2xl border border-rule bg-cream">
          <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-2.5">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.05em] text-inkMuted">
              <Brain className="h-3.5 w-3.5" aria-hidden="true" />
              Saved to memory
            </p>
            <Link
              href={href}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-rule px-3 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 relative after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-['']"
            >
              Open memory
              <NextChevron className="text-inkMuted" />
            </Link>
          </div>
          <ul className="divide-y divide-rule px-4">
            {visible.map((item) => (
              <li key={item.note_id} className="py-3">
                {item.kind === "conflict" ? (
                  <ConflictRow
                    item={item}
                    state={rows[item.note_id]}
                    keptNoteId={keptId[item.note_id]}
                    onKeep={(noteId) => void keep(item, noteId)}
                  />
                ) : item.kind === "updated" ? (
                  <UpdatedRow item={item} state={rows[item.note_id]} onUndo={() => void undoUpdate(item)} />
                ) : (
                  <AddedRow
                    item={item}
                    mode={modes[item.note_id]}
                    onForget={() => forget(item.note_id)}
                    onUndo={() => void undo(item.note_id)}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Line({ text, gone, note }: { text: string; gone?: boolean; note?: string | null }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span aria-hidden="true" className={`mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full ${gone ? "bg-inkLight/50" : "bg-success"}`} />
      <div className="min-w-0">
        <p className={`text-[14px] leading-[1.45] ${gone ? "text-inkMuted line-through" : "text-ink"}`}>{text}</p>
        {note ? <p className="mt-0.5 text-[13px] text-inkMuted">{note}</p> : null}
      </div>
    </div>
  );
}

function AddedRow({
  item,
  mode,
  onForget,
  onUndo,
}: {
  item: MemoryWriteItem;
  mode: string | undefined;
  onForget: () => void;
  onUndo: () => void;
}) {
  const forgotten = !!mode && HIDDEN_MODES.has(mode);
  const note = mode ? (FORGET_NOTES[mode] ?? null) : null;
  return (
    <div className="flex items-center justify-between gap-3">
      <Line text={item.title} gone={forgotten} note={note} />
      {forgotten ? (
        <button type="button" onClick={onUndo} disabled={!UNDOABLE_MODES.has(mode!)} className={rowBtn}>
          Undo
        </button>
      ) : (
        <button type="button" onClick={onForget} className={rowBtn}>
          Forget
        </button>
      )}
    </div>
  );
}

function UpdatedRow({ item, state, onUndo }: { item: MemoryWriteItem; state?: RowState; onUndo: () => void }) {
  const undone = state === "undone";
  const note = undone
    ? "Change undone"
    : state === "error"
      ? "Could not undo this change. Try again."
      : item.previous?.title
        ? `was ${item.previous.title}`
        : null;
  return (
    <div className="flex items-center justify-between gap-3">
      <Line text={item.title} gone={undone} note={note} />
      {undone ? null : (
        <button type="button" onClick={onUndo} disabled={state === "busy"} className={rowBtn}>
          Undo
        </button>
      )}
    </div>
  );
}

function ConflictRow({
  item,
  state,
  keptNoteId,
  onKeep,
}: {
  item: MemoryWriteItem;
  state?: RowState;
  keptNoteId?: string;
  onKeep: (noteId: string) => void;
}) {
  const values = [
    { note_id: item.note_id, text: item.body_excerpt || item.title, label: "From this reply" },
    {
      note_id: item.conflict_with!.note_id,
      text: item.conflict_with!.body_excerpt || item.conflict_with!.title,
      label: "Saved earlier",
    },
  ];
  if (state === "kept" && keptNoteId) {
    const k = values.find((v) => v.note_id === keptNoteId);
    return <Line text={k?.text ?? item.title} note="Kept. The other value is marked out of date." />;
  }
  return (
    <div>
      <p className="text-[13px] text-inkMuted">
        {state === "error" ? "Could not save your answer. Try again." : "Which one is right?"}
      </p>
      <ul className="mt-1 space-y-1.5">
        {values.map((v) => (
          <li key={v.note_id} className="flex items-center justify-between gap-3">
            <Line text={v.text} note={v.label} />
            <button type="button" onClick={() => onKeep(v.note_id)} disabled={state === "busy"} className={rowBtn}>
              Keep this
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
