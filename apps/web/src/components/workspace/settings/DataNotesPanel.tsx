"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { Skeleton } from "../Skeleton";
import { BTN_TEXT, Section, errorMessageOf } from "../personalization/shared";

export type DataNoteRow = {
  id: string;
  metric_id: string | null;
  metric_label: string | null;
  note_text: string;
  created_at: string;
};

function savedOn(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function DataNotesPanel({ readOnly = false }: { readOnly?: boolean }) {
  const [notes, setNotes] = useState<DataNoteRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch("/api/tenant/me/data-notes");
      const body = (await res.json().catch(() => null)) as { notes?: DataNoteRow[] } | null;
      if (!res.ok) throw new Error(errorMessageOf(body, `HTTP ${res.status}`));
      setNotes(body?.notes ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load data notes.");
      setNotes([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (id: string) => {
    setRemoving(id);
    setError(null);
    try {
      const res = await apiFetch(`/api/tenant/me/data-notes/${encodeURIComponent(id)}`, { method: "DELETE" });
      const body = await res.json().catch(() => null);
      if (!res.ok && res.status !== 404) throw new Error(errorMessageOf(body, `HTTP ${res.status}`));
      setNotes((prev) => (prev ?? []).filter((n) => n.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the note.");
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Section
      id="data-notes"
      title={`Data notes${notes ? ` (${notes.length})` : ""}`}
      description="When you tell Zavi a number is wrong, the fix is saved here and shown on that number's receipt."
    >
      {notes === null ? (
        <Skeleton className="h-16 w-full" rounded="rounded-[12px]" />
      ) : notes.length === 0 ? (
        <p className="rounded-[12px] border border-dashed border-rule p-3.5 text-[13px] text-inkMuted">No data notes yet.</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="flex flex-wrap items-start gap-3 rounded-[12px] border border-rule p-3.5">
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium leading-5 text-ink">{n.note_text}</p>
                <p className="mt-1 text-[13px] text-inkMuted">
                  {n.metric_label ? `Applies to ${n.metric_label}` : "Applies to all your numbers"}
                  {savedOn(n.created_at) ? `, saved in chat ${savedOn(n.created_at)}` : ""}
                </p>
              </div>
              {!readOnly ? (
                <button
                  type="button"
                  className={BTN_TEXT}
                  disabled={removing === n.id}
                  onClick={() => void remove(n.id)}
                  aria-label={`Remove data note: ${n.note_text}`}
                >
                  {removing === n.id ? "Removing" : "Remove"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-ink">
          {error}
        </p>
      ) : null}
    </Section>
  );
}
