"use client";

import { useState } from "react";

export type SecretEntry = {
  hint: string;
  seat: string | null;
  note: string | null;
  note_updated_by: string | null;
  note_updated_at: string | null;
};

export const SEAT_NOTE_MAX = 280;

export type SecretOp = "set" | "append" | "append_with_note" | "remove" | "replace" | "note";
export type SecretExtra = { note?: string; target?: string; expected_revision?: string | null };
export type SaveGlobal = (key: string, value: unknown, op?: SecretOp, extra?: SecretExtra) => Promise<boolean>;

export type SecretSettingRow = {
  key: string;
  description: string;
  scope: string;
  globalValue: unknown;
  secretItems?: string[];
  secretEntries?: SecretEntry[];
  notesAvailable?: boolean;
  secretRevision?: string | null;
};

function isSecretConfigured(globalValue: unknown): boolean {
  return typeof globalValue === "string" && globalValue.trim() !== "";
}

export function SecretSettingCard({
  row,
  onSaveGlobal,
}: {
  row: SecretSettingRow;
  onSaveGlobal: SaveGlobal;
}) {
  const [draft, setDraft] = useState("");
  const [draftNote, setDraftNote] = useState("");
  const [busy, setBusy] = useState(false);
  const configured = isSecretConfigured(row.globalValue);
  const entries: SecretEntry[] =
    row.secretEntries ??
    (row.secretItems ?? []).map((hint) => ({ hint, seat: null, note: null, note_updated_by: null, note_updated_at: null }));
  const notesOn = Boolean(row.secretEntries) && row.notesAvailable === true;
  const revision = row.secretRevision ?? null;
  const draftTokens = draft.split(/[\s,]+/).filter(Boolean);
  const noteNeedsOneToken = notesOn && draftNote.trim() !== "" && draftTokens.length > 1;

  async function write(value: string, op: SecretOp, extra?: SecretExtra): Promise<boolean> {
    setBusy(true);
    try {
      return await onSaveGlobal(row.key, value, op, extra);
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const note = notesOn ? draftNote.trim() : "";
    const ok = note
      ? await write(draft.trim(), "append_with_note", { note })
      : await write(draft.trim(), "append");
    if (ok) {
      setDraft("");
      setDraftNote("");
    }
  }

  async function overwrite(message: string, value: string) {
    if (!window.confirm(message)) return;
    if (await write(value, "set", { expected_revision: revision })) setDraft("");
  }

  const lastOne = entries.length === 1;

  return (
    <div className="border rounded p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <code className="text-sm font-semibold">{row.key}</code>
            <span className="text-sm uppercase tracking-wide text-gray-500 border rounded px-1.5 py-0.5">
              secret
            </span>
            <span className="text-sm uppercase tracking-wide text-gray-500 border rounded px-1.5 py-0.5">
              {row.scope}
            </span>
          </div>
          <p className="text-sm text-gray-600 mt-1">{row.description}</p>
        </div>
        <span
          className={
            "shrink-0 rounded-full px-3 py-1 text-xs font-medium " +
            (configured ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600")
          }
        >
          {configured ? `${entries.length} configured` : "not configured"}
        </span>
      </div>

      {entries.length > 0 && (
        <ul className="mt-3 divide-y divide-gray-100 border rounded">
          {entries.map((entry, i) => (
            <SecretEntryRow
              key={entry.seat ?? `${entry.hint}-${i}`}
              entry={entry}
              notesOn={notesOn}
              busy={busy}
              onRemove={() => {
                const msg = lastOne
                  ? `Remove ${entry.hint}? It is the last one: the fleet falls back to the deployed env tokens.`
                  : `Remove ${entry.hint} from the pool?`;
                if (window.confirm(msg)) void write(entry.seat ?? entry.hint, "remove");
              }}
              onSaveNote={(note) =>
                entry.seat ? write(note, "note", { target: entry.seat, expected_revision: revision }) : Promise.resolve(false)
              }
              onReplace={(token) =>
                entry.seat
                  ? write(token, "replace", { target: entry.seat, expected_revision: revision })
                  : Promise.resolve(false)
              }
            />
          ))}
        </ul>
      )}

      {row.secretEntries && !notesOn && (
        <p className="text-sm text-amber-700 mt-2">
          Notes are unavailable on this server right now, so they are hidden. Tokens can still be edited.
        </p>
      )}

      <div className="mt-3 border-t border-gray-100 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={configured ? "paste a token to add to the pool" : "paste token(s), comma-separated"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            className="min-w-0 flex-1 border rounded px-2 py-1 font-mono text-xs"
          />
          {notesOn && (
            <input
              type="text"
              autoComplete="off"
              maxLength={SEAT_NOTE_MAX}
              placeholder="note (optional), e.g. Max seat for ops, renews 11-03"
              value={draftNote}
              onChange={(e) => setDraftNote(e.target.value)}
              disabled={busy}
              className="min-w-0 flex-1 border rounded px-2 py-1 text-sm"
            />
          )}
          <button
            type="button"
            className="shrink-0 border rounded px-3 py-1 text-sm bg-gray-900 text-white disabled:opacity-50"
            onClick={() => void add()}
            disabled={busy || !draft.trim() || noteNeedsOneToken}
          >
            {busy ? "Saving…" : "Add"}
          </button>
          {configured && (
            <>
              <button
                type="button"
                className="shrink-0 text-xs text-gray-500 underline hover:text-gray-800 disabled:opacity-50"
                onClick={() =>
                  void overwrite(
                    `Replace all ${entries.length} stored token(s) with what you pasted? Notes on tokens you leave out are deleted.`,
                    draft.trim(),
                  )
                }
                disabled={busy || !draft.trim()}
              >
                replace all
              </button>
              <button
                type="button"
                className="shrink-0 text-xs text-gray-400 underline hover:text-gray-700 disabled:opacity-50"
                onClick={() =>
                  void overwrite(
                    `Clear all ${entries.length} token(s) and their notes? The fleet falls back to the deployed env tokens.`,
                    "",
                  )
                }
                disabled={busy}
              >
                clear
              </button>
            </>
          )}
        </div>
        {noteNeedsOneToken && (
          <p className="text-sm text-amber-700 mt-1">Add one token at a time when giving it a note.</p>
        )}
        <p className="text-sm text-gray-400 mt-1">
          Write-only. Stored tokens are never sent back to this page, only their last 4
          characters and seat label. &ldquo;Add&rdquo; keeps the existing tokens (duplicates skipped);
          &ldquo;replace all&rdquo; overwrites them; &ldquo;clear&rdquo; reverts to the deployed env
          fallback. Notes are internal and visible to all staff; never put a token in one.
          Takes effect within ~60s. Audit-logged without the token or note text.
        </p>
      </div>
    </div>
  );
}

function SecretEntryRow({
  entry,
  notesOn,
  busy,
  onRemove,
  onSaveNote,
  onReplace,
}: {
  entry: SecretEntry;
  notesOn: boolean;
  busy: boolean;
  onRemove: () => void;
  onSaveNote: (note: string) => Promise<boolean>;
  onReplace: (token: string) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<"view" | "note" | "replace">("view");
  const [noteDraft, setNoteDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");

  function startNote() {
    setNoteDraft(entry.note ?? "");
    setMode("note");
  }

  async function saveNote() {
    if (await onSaveNote(noteDraft.trim())) setMode("view");
  }

  async function replace() {
    if (await onReplace(tokenDraft.trim())) {
      setTokenDraft("");
      setMode("view");
    }
  }

  return (
    <li className="px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-xs text-gray-700">{entry.hint}</span>
        {entry.seat && <span className="font-mono text-xs text-gray-400">{entry.seat}</span>}
        {notesOn && mode !== "note" && (
          <span className={"min-w-0 flex-1 " + (entry.note ? "text-gray-800" : "text-gray-400 italic")}>
            {entry.note ?? "no note"}
          </span>
        )}
        {!notesOn && <span className="flex-1" />}
        {mode === "view" && (
          <span className="ml-auto flex shrink-0 items-center gap-3 text-xs">
            {notesOn && entry.seat && (
              <button type="button" className="text-gray-500 underline hover:text-gray-800 disabled:opacity-50" disabled={busy} onClick={startNote}>
                {entry.note ? "edit note" : "add note"}
              </button>
            )}
            {entry.seat && (
              <button
                type="button"
                className="text-gray-500 underline hover:text-gray-800 disabled:opacity-50"
                disabled={busy}
                onClick={() => setMode("replace")}
                title="Swap in a refreshed token for the same seat; the note moves to it"
              >
                replace
              </button>
            )}
            <button
              type="button"
              className="text-gray-400 hover:text-red-700 disabled:opacity-50"
              title={`remove ${entry.hint}`}
              aria-label={`remove ${entry.hint}`}
              disabled={busy}
              onClick={onRemove}
            >
              ×
            </button>
          </span>
        )}
      </div>
      {entry.note && entry.note_updated_by && mode === "view" && notesOn && (
        <div className="mt-0.5 text-xs text-gray-400">
          note by {entry.note_updated_by}
          {entry.note_updated_at ? ` · ${new Date(entry.note_updated_at).toLocaleString()}` : ""}
        </div>
      )}
      {mode === "note" && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="text"
            autoFocus
            autoComplete="off"
            maxLength={SEAT_NOTE_MAX}
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveNote();
              if (e.key === "Escape") setMode("view");
            }}
            disabled={busy}
            placeholder="e.g. Max seat for ops, renews 11-03 (empty removes the note)"
            className="min-w-0 flex-1 border rounded px-2 py-1 text-sm"
          />
          <button type="button" className="shrink-0 border rounded px-3 py-1 text-sm bg-gray-900 text-white disabled:opacity-50" disabled={busy} onClick={() => void saveNote()}>
            Save
          </button>
          <button type="button" className="shrink-0 text-xs text-gray-500 underline" disabled={busy} onClick={() => setMode("view")}>
            cancel
          </button>
        </div>
      )}
      {mode === "replace" && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            disabled={busy}
            placeholder={`refreshed token to replace ${entry.hint}`}
            className="min-w-0 flex-1 border rounded px-2 py-1 font-mono text-xs"
          />
          <button
            type="button"
            className="shrink-0 border rounded px-3 py-1 text-sm bg-gray-900 text-white disabled:opacity-50"
            disabled={busy || !tokenDraft.trim()}
            onClick={() => void replace()}
          >
            Replace
          </button>
          <button
            type="button"
            className="shrink-0 text-xs text-gray-500 underline"
            disabled={busy}
            onClick={() => {
              setTokenDraft("");
              setMode("view");
            }}
          >
            cancel
          </button>
        </div>
      )}
    </li>
  );
}
