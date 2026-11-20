"use client";

import { useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import type { AdReviewChanges, AdReviewResponse } from "@zavi/shared";
import { Button } from "@/components/ui/Button";
import { AdReviewSchedule } from "./AdReviewSchedule";
import { AdEditDialog } from "./AdEditDialog";
import type { AdReviewModel } from "./adReviewModel";

interface Props {
  actionId?: string;
  model: AdReviewModel;
  review: AdReviewResponse | null;
  busy?: boolean;
  readOnly?: boolean;
  saveNote?: boolean;
  onSave?: (edits: AdReviewChanges & { request_id: string }) => Promise<boolean>;
  children?: ReactNode;
}

export function AdReviewEditing({ actionId, model, review, busy, readOnly, saveNote = true, onSave, children }: Props) {
  const scheduleOnly = !!review?.fields.length && review.fields.every((field) => ["date", "datetime"].includes(field.kind));
  const [editing, setEditing] = useState(false);
  const showForm = editing && !readOnly && !!review?.editable && !!onSave && !!review.review?.revision;
  return <>
    {!showForm && <AdReviewSchedule model={model} />}
    {!showForm && review && !review.editable && review.limitations.length > 0 && <div data-testid="ad-review-locked" className="mt-3 space-y-1 text-sm leading-5 text-inkMuted">{review.limitations.map((message) => <p key={message}>{message}</p>)}</div>}
    {!readOnly && review?.editable && onSave && review.review?.revision && (showForm ?
      <AdReviewEditForm key={review.review.revision} actionId={actionId} model={model} review={review} revision={review.review.revision} onSave={onSave} busy={busy} saveNote={saveNote} onCancel={() => setEditing(false)} /> :
      <Button type="button" variant="secondary" className="mt-4 gap-2" onClick={() => setEditing(true)} disabled={busy}><Pencil className="size-4" aria-hidden />{scheduleOnly ? "Edit schedule" : "Edit ad"}</Button>)}
    {!showForm && children}
  </>;
}

export function AdReviewEditForm({ model, review, revision, onSave, onCancel, busy, saveNote, subtitle }: Required<Pick<Props, "onSave">> & { actionId?: string; subtitle?: string; saveNote: boolean; model: AdReviewModel; review: AdReviewResponse; revision: string; onCancel: () => void; busy?: boolean }) {
  return <AdEditDialog model={model} review={review} revision={revision} onSave={onSave} onCancel={onCancel} busy={busy} saveNote={saveNote} subtitle={subtitle} />;
}
