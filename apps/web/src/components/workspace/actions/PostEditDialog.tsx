"use client";

import type { ReactNode } from "react";
import { Check, RotateCcw } from "lucide-react";
import { ActionEditDialog } from "./ActionEditDialog";
import { CardButton } from "./card/CardButton";

const label = "flex items-center justify-between gap-3 text-ca-label font-medium text-ca-xdark";
const count = "text-ca-action font-normal tabular-nums text-ca-secondary";
const field = "w-full resize-y rounded-xl border border-ca-strong bg-ca-bg px-3.5 py-3 text-ca-row text-ca-xdark placeholder:text-ca-secondary focus-visible:shadow-ca-focus focus-visible:outline-none disabled:opacity-60";
const note = "text-ca-action text-ca-secondary";

export function PostEditDialog({ title, heading, icon, contentLabel, photoFields, text, thread, limit, measure, saving, error, persisted, invalidReason = null, onText, onThread, onSave, onCancel, onReset }: {
  title: string;
  heading: string;
  icon?: ReactNode;
  contentLabel: string;
  photoFields?: ReactNode;
  text: string;
  thread: string[] | null;
  limit?: number;
  measure: (value: string) => number;
  saving: boolean;
  error: string;
  persisted: boolean;
  invalidReason?: string | null;
  onText: (value: string) => void;
  onThread: (value: string[]) => void;
  onSave: () => void;
  onCancel: () => void;
  onReset: () => void;
}) {
  return <ActionEditDialog title={heading} subtitle={title} icon={icon} divided busy={saving} onClose={onCancel} footer={<>
    <CardButton variant="ghost" disabled={saving} onClick={onReset}><RotateCcw className="size-4" aria-hidden />Reset to Zavi&apos;s version</CardButton>
    <CardButton variant="ghost" disabled={saving} onClick={onCancel} className="ml-auto">Cancel</CardButton>
    <CardButton variant="primary" disabled={saving || !!invalidReason} onClick={onSave}><Check className="size-4" aria-hidden />{saving ? "Saving…" : "Save"}</CardButton>
  </>}>
    {photoFields}
    <section aria-label="Words" className="space-y-4">
      {photoFields && <h4 className="text-ca-title font-semibold text-ca-xdark">Words</h4>}
      <label className="flex min-w-0 flex-col gap-2.5">
        <span className={label}><span>{contentLabel}</span>{limit !== undefined && <span className={count}>{measure(text)}/{limit}</span>}</span>
        <textarea aria-label="Edit post" value={text} onChange={(event) => onText(event.target.value)} disabled={saving} rows={photoFields ? 4 : heading === "Edit the article" ? 12 : 8} className={field} />
      </label>
      {thread?.map((part, index) => <label key={index} className="flex min-w-0 flex-col gap-2.5">
        <span className={label}><span>Part {index + 2}</span>{limit !== undefined && <span className={count}>{measure(part)}/{limit}</span>}</span>
        <textarea aria-label={`Edit part ${index + 2}`} value={part} onChange={(event) => onThread(thread.map((value, position) => position === index ? event.target.value : value))} disabled={saving} rows={4} className={field} />
      </label>)}
    </section>
    {!persisted && <p className={note}>Edits stay on this card until you leave the page. Posting or copying uses your edited version.</p>}
    {invalidReason && <p role="status" className="text-ca-action text-ca-danger">{invalidReason}</p>}
    {error && <p role="alert" className="text-ca-action text-ca-danger">{error}</p>}
  </ActionEditDialog>;
}
