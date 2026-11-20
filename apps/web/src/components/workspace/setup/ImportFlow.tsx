"use client";

import { useRef, useState } from "react";
import { ArrowRight, Check, ChevronDown, FileText, ImageIcon, KeyRound, Loader2, Upload } from "lucide-react";
import { ACCEPT, admitFiles, rowLabel, type FileRow } from "./importFiles";
import { summarizeReads, uploadImport, type ImportFile } from "./importReads";
import { useSetupOptional } from "./SetupProvider";
import { PRIMARY, SECONDARY, SkipButton, StickyActions } from "./SetupSteps";
import * as copy from "./setupCopy";

function rowOf(f: ImportFile): FileRow {
  return { key: f.id, name: f.filename, size: 0, status: f.status, facts: f.facts, redactions: f.redactions, truncated: f.truncated, reason: f.reason };
}

export async function uploadAll(
  files: readonly File[],
  onRow: (row: FileRow | { key: string; remove: true; id: string }) => void,
): Promise<number> {
  let stored = 0;
  for (const row of admitFiles(files)) {
    if (row.status !== "waiting" || !row.file) {
      onRow(row);
      continue;
    }
    onRow({ ...row, status: "waiting", reason: undefined });
    const out = await uploadImport(row.file);
    if (out.ok) {
      stored += 1;
      onRow({ key: row.key, remove: true, id: out.id });
    } else {
      onRow({ ...row, status: "failed", reason: out.reason, file: undefined });
    }
  }
  return stored;
}

export function ImportFlow({
  onUploaded,
  onDone,
  doneLabel = "I am done",
  doneStyle = "secondary",
  onSkip,
}: {
  onUploaded?: () => void | Promise<void>;
  onDone: () => void | Promise<void>;
  doneLabel?: string;
  doneStyle?: "primary" | "secondary";
  onSkip?: () => void | Promise<void>;
}) {
  const setup = useSetupOptional();
  const imports = setup?.imports ?? null;
  const [local, setLocal] = useState<FileRow[]>([]);
  const [storedAny, setStoredAny] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showPrompt, setShowPrompt] = useState(true);
  const [copied, setCopied] = useState(false);
  const [codingOpen, setCodingOpen] = useState(false);
  const tucked = setup?.state?.enabled === true && setup.state.coding_prompt_tucked === true;
  const input = useRef<HTMLInputElement>(null);
  const files = imports?.files ?? [];
  const reads = summarizeReads(files);

  const start = async (dropped: File[]) => {
    if (dropped.length === 0 || busy) return;
    setBusy(true);
    setLocal([]);
    let failed = 0;
    const ids: string[] = [];
    try {
      const stored = await uploadAll(dropped, (r) => {
        if ("remove" in r) ids.push(r.id);
        else if (r.status === "failed") failed += 1;
        setLocal((rows) => {
          if ("remove" in r) return rows.filter((x) => x.key !== r.key);
          return rows.some((x) => x.key === r.key) ? rows.map((x) => (x.key === r.key ? r : x)) : [...rows, r];
        });
      });
      if (stored > 0) {
        setStoredAny(true);
        const after = setup?.afterRead;
        if (ids.length && after) {
          const open = files.some((f) => after.files.includes(f.id) && f.status === "reading");
          setup?.setAfterRead?.(open ? { ...after, files: [...after.files, ...ids] } : { files: ids, untouched: [] });
        } else if (ids.length && setup?.state?.enabled && setup.state.done) {
          setup?.setAfterRead?.({ files: ids, untouched: [] });
        }
        await imports?.refresh();
        if (failed === 0) await onUploaded?.();
      }
    } finally {
      setBusy(false);
    }
  };

  const rows = [...local, ...files.map(rowOf)];
  const keysRows = files.filter((f) => f.redactions > 0);
  const canFinish = files.length > 0 || storedAny || !onSkip;

  return (
    <div>
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void start(Array.from(e.dataTransfer.files));
        }}
        className="flex w-full items-center gap-4 rounded-2xl border-[1.5px] border-dashed border-inkLight/50 bg-creamDeep p-[22px] text-left hover:border-inkMuted"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-rule bg-white">
          <Upload className="h-5 w-5 text-ink" aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="block text-[14px] font-semibold text-ink">{copy.DROP_TITLE}</span>
          <span className="block text-[13px] text-inkMuted">{copy.DROP_LIMITS}</span>
        </span>
      </button>
      <input
        ref={input}
        data-testid="import-input"
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          void start(picked);
        }}
      />
      {tucked && (
        <button
          type="button"
          onClick={() => setCodingOpen((v) => !v)}
          aria-expanded={codingOpen}
          className="mt-5 inline-flex items-center gap-1 px-1 text-[13px] text-inkMuted underline-offset-2 hover:text-ink hover:underline"
        >
          {copy.CODING_TOOL_TOGGLE}
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${codingOpen ? "rotate-180" : ""}`} aria-hidden />
        </button>
      )}
      {(!tucked || codingOpen) && (
        <div className={tucked ? "mt-3" : "mt-5"}>
          <div className="flex flex-wrap items-center gap-2 text-[14px]">
            <span className="text-inkMuted">{copy.BUNDLE_TITLE}</span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(copy.BUNDLE_PROMPT);
                setCopied(true);
              }}
              className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-cta border border-rule bg-white px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-creamDeep"
            >
              {copied && <Check className="h-4 w-4" aria-hidden />}
              {copied ? "Copied" : "Copy prompt"}
            </button>
            <button
              type="button"
              onClick={() => setShowPrompt((v) => !v)}
              aria-expanded={showPrompt}
              className="px-1 text-[13px] text-inkMuted underline-offset-2 hover:text-ink hover:underline"
            >
              {showPrompt ? copy.HIDE_PROMPT : copy.SEE_PROMPT}
            </button>
          </div>
          <p data-testid="bundle-help" className="mt-2 text-[13px] text-inkMuted">{copy.BUNDLE_HELP}</p>
          {showPrompt && (
            <pre className="mt-2.5 max-h-[220px] overflow-auto whitespace-pre-wrap rounded-xl border border-rule bg-cream p-3.5 text-[12px] leading-[1.55] text-ink" style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{copy.BUNDLE_PROMPT}</pre>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <ul className="mt-4 divide-y divide-rule rounded-2xl border border-rule bg-cream">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-3 px-4 py-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-creamDeep">
                {r.status === "stored" ? <ImageIcon className="h-4 w-4 text-inkMuted" aria-hidden /> : <FileText className="h-4 w-4 text-inkMuted" aria-hidden />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold text-ink">{r.name}</span>
                {r.truncated && <span className="block text-[12px] text-inkMuted">{copy.TRUNCATED_LINE}</span>}
              </span>
              <span
                className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${
                  r.status === "done" ? "bg-success/10 text-success" : r.status === "failed" || r.status === "stored" ? "bg-marigold/15 text-ink" : "bg-creamDeep text-inkMuted"
                }`}
              >
                {r.status === "reading" && <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />}
                {rowLabel(r)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {keysRows.map((f) => (
        <p key={f.id} role="status" className="mt-4 flex items-start gap-2 rounded-xl bg-marigold/15 px-4 py-3 text-[13px] leading-5 text-ink">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{copy.keysRemovedLine(f.redactions, f.filename)}</span>
        </p>
      ))}
      {reads.done.length > 0 && (
        <p className="mt-4 text-[14px] leading-6 text-ink">
          <b>{copy.learnedLine(reads.facts, reads.done.length)}</b> <span className="text-inkMuted">{copy.LEARNED_WHERE}</span>
        </p>
      )}

      {!onSkip && (
        <div className="mt-5 flex items-center gap-3">
          <button type="button" className={doneStyle === "primary" && canFinish ? SECONDARY : PRIMARY} disabled={busy} onClick={() => input.current?.click()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
            Choose files
          </button>
          <button type="button" className={doneStyle === "primary" ? PRIMARY : SECONDARY} disabled={busy} onClick={() => void onDone()}>
            {doneLabel}
          </button>
        </div>
      )}
      {}
      {onSkip && (
        <StickyActions skip={!canFinish ? <SkipButton onSkip={() => void onSkip()} /> : undefined}>
          {canFinish ? (
            <button type="button" className={PRIMARY} disabled={busy} onClick={() => void onDone()}>
              {doneLabel}
            </button>
          ) : (
            <button type="button" className={PRIMARY} disabled={busy} onClick={() => input.current?.click()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
              Choose files
            </button>
          )}
        </StickyActions>
      )}
    </div>
  );
}
