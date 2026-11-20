"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { cx } from "../layout/shared";
import { BTN_PRIMARY, BTN_SECONDARY, BTN_TEXT, errorMessageOf, INPUT, Section, TEXTAREA, Updated } from "./shared";

type Hit = {
  note_id: string;
  title: string;
  body: string;
  source?: string;
  note_type?: string;
  created_at?: string;
  superseded_by?: string | null;
};

type Row = { id: string; title: string; body: string; source: string; at: string | null; superseded: boolean };

const SOURCE_LABEL: Record<string, string> = {
  human: "Added by your team",
  agent_write: "Learned by an agent",
  agent_distill: "Learned by an agent",
  onboarding: "From onboarding",
};

function sourceLabel(s: string): string {
  return SOURCE_LABEL[s] ?? (s ? s.replaceAll("_", " ") : "Unknown source");
}

export function LearnedFactsSection({ readOnly, onChanged }: { readOnly: boolean; onChanged: () => void }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string; ready: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  async function search() {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch("/api/memory/search", { method: "POST", body: JSON.stringify({ query: q, k: 12 }) });
      const body = (await res.json().catch(() => null)) as { hits?: Hit[] } | null;
      if (!res.ok) throw new Error(errorMessageOf(body, `HTTP ${res.status}`));
      const seen = new Set<string>();
      const next: Row[] = [];
      for (const h of body?.hits ?? []) {
        if (!h.note_id || seen.has(h.note_id)) continue;
        seen.add(h.note_id);
        next.push({
          id: h.note_id,
          title: h.title,
          body: h.body,
          source: h.source ?? "",
          at: h.created_at ?? null,
          superseded: !!h.superseded_by,
        });
      }
      setRows(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setSearching(false);
    }
  }

  async function addAsFact() {
    const text = query.trim();
    if (!text) return;
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch("/api/memory/notes", {
        method: "POST",
        body: JSON.stringify({
          title: text.length > 80 ? `${text.slice(0, 77)}…` : text,
          body_markdown: text,
          note_type: "tenant_reference",
          tags: ["personalization"],
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorMessageOf(body, `HTTP ${res.status}`));
      setNotice("Saved. Your agents will use this from their next run.");
      setQuery("");
      setRows(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setAdding(false);
    }
  }

  async function startCorrect(row: Row) {
    setRowError(null);
    setEditing({ id: row.id, body: "", ready: false });
    try {
      const res = await apiFetch(`/api/memory/notes/${row.id}`);
      const resBody = (await res.json().catch(() => null)) as { note?: { body_markdown?: unknown } } | null;
      if (!res.ok) throw new Error(errorMessageOf(resBody, `HTTP ${res.status}`));
      const full = resBody?.note?.body_markdown;
      if (typeof full !== "string") throw new Error("Could not load the full fact.");
      setEditing((cur) => (cur?.id === row.id && !cur.ready ? { id: row.id, body: full, ready: true } : cur));
    } catch (e) {
      setEditing((cur) => (cur?.id === row.id && !cur.ready ? null : cur));
      setRowError({ id: row.id, message: e instanceof Error ? e.message : "Could not load the full fact." });
    }
  }

  async function correct(row: Row, body: string) {
    setBusy(row.id);
    setRowError(null);
    try {
      const res = await apiFetch(`/api/memory/notes/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({ body_markdown: body, reason: "corrected on the Personalization page" }),
      });
      const resBody = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorMessageOf(resBody, `HTTP ${res.status}`));
      setRows((rs) => rs?.map((r) => (r.id === row.id ? { ...r, body, at: new Date().toISOString(), source: "human" } : r)) ?? null);
      setEditing(null);
      onChanged();
    } catch (e) {
      setRowError({ id: row.id, message: e instanceof Error ? e.message : "Could not save." });
    } finally {
      setBusy(null);
    }
  }

  async function remove(row: Row) {
    if (!window.confirm("Remove this from what your agents know? This cannot be undone.")) return;
    setBusy(row.id);
    setRowError(null);
    try {
      const res = await apiFetch(`/api/memory/notes/${row.id}`, {
        method: "DELETE",
        body: JSON.stringify({ reason: "removed on the Personalization page" }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorMessageOf(body, `HTTP ${res.status}`));
      setRows((rs) => rs?.filter((r) => r.id !== row.id) ?? null);
      onChanged();
    } catch (e) {
      setRowError({ id: row.id, message: e instanceof Error ? e.message : "Could not remove." });
    } finally {
      setBusy(null);
    }
  }

  async function restore(row: Row) {
    setBusy(row.id);
    setRowError(null);
    try {
      const res = await apiFetch(`/api/memory/notes/${row.id}/unsupersede`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorMessageOf(body, `HTTP ${res.status}`));
      setRows((rs) => rs?.map((r) => (r.id === row.id ? { ...r, superseded: false } : r)) ?? null);
      onChanged();
    } catch (e) {
      setRowError({ id: row.id, message: e instanceof Error ? e.message : "Could not restore." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section
      id="learned-facts"
      title="Learned facts"
      description="Ask what your agents believe about something, then correct it, remove it, or add what they should know."
    >
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="block text-[14px] font-medium leading-5 text-ink">Ask or update</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. What do we charge for late returns?"
            maxLength={2000}
            className={INPUT}
          />
        </label>
        <button type="submit" disabled={searching || !query.trim()} className={BTN_PRIMARY}>
          {searching ? "Searching…" : "Ask"}
        </button>
        {!readOnly ? (
          <button type="button" onClick={() => void addAsFact()} disabled={adding || !query.trim()} className={BTN_SECONDARY}>
            {adding ? "Saving…" : "Add as fact"}
          </button>
        ) : null}
      </form>
      <div aria-live="polite" role="status" className="mt-2 text-[13px]">
        {error ? <p className="text-ink">{error}</p> : null}
        {notice ? <p className="text-inkMuted">{notice}</p> : null}
      </div>

      {rows !== null ? (
        rows.length === 0 ? (
          <p className="mt-3 text-[13px] text-inkMuted">
            Nothing on file about that. {readOnly ? "" : "Use Add as fact to tell your agents."}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-rule">
            {rows.map((row) => {
              const isEditing = editing?.id === row.id;
              return (
                <li key={row.id} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                    <div className="min-w-0 flex-1">
                      <p className="text-[16px] font-medium leading-5 text-ink">{row.title}</p>
                      {isEditing ? (
                        <textarea
                          rows={4}
                          value={editing.ready ? editing.body : "Loading…"}
                          disabled={!editing.ready}
                          onChange={(e) => setEditing({ id: row.id, body: e.target.value, ready: true })}
                          aria-label={`Correct ${row.title}`}
                          className={TEXTAREA}
                        />
                      ) : (
                        <p className={cx("mt-0.5 whitespace-pre-wrap text-[16px] leading-5 text-inkMuted", row.superseded && "line-through")}>
                          {row.body.length > 600 ? `${row.body.slice(0, 597)}…` : row.body}
                        </p>
                      )}
                      <p className="mt-1 text-[12px] text-inkLight">
                        {sourceLabel(row.source)} · <Updated at={row.at} prefix="Added" />
                        {row.superseded ? " · Superseded" : ""}
                      </p>
                    </div>
                    {!readOnly ? (
                      <div className="flex shrink-0 items-center gap-1">
                        {isEditing ? (
                          <>
                            <button
                              type="button"
                              disabled={busy === row.id || !editing.ready || !editing.body.trim()}
                              onClick={() => void correct(row, editing.body.trim())}
                              className={BTN_PRIMARY}
                            >
                              {busy === row.id ? "Saving…" : "Save"}
                            </button>
                            <button type="button" disabled={busy === row.id} onClick={() => setEditing(null)} className={BTN_TEXT.replace("h-8", "h-10")}>
                              Cancel
                            </button>
                          </>
                        ) : row.superseded ? (
                          <button type="button" disabled={busy === row.id} onClick={() => void restore(row)} className={BTN_TEXT}>
                            Restore
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={busy === row.id}
                              onClick={() => void startCorrect(row)}
                              className={BTN_TEXT}
                            >
                              Correct
                            </button>
                            <button type="button" disabled={busy === row.id} onClick={() => void remove(row)} className={BTN_TEXT}>
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                  {rowError?.id === row.id ? (
                    <p role="alert" className="mt-1 text-[13px] text-ink">
                      {rowError.message}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </Section>
  );
}
