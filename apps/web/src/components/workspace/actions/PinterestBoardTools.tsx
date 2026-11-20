"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";

export type PinterestBoardOption = { id: string; label: string };

const BOARDS_URL = "/api/channels/pinterest_organic/boards";
const NAME_MAX = 50;
const DESCRIPTION_MAX = 500;

const input =
  "h-10 w-full rounded-lg border border-[#e5e7eb] bg-white px-3 text-[14px] text-[#0e0f11] outline-none placeholder:text-[#a8a8a8] focus:border-[#0e0f11] disabled:bg-[#fbfaf7]";
const action =
  "cursor-pointer rounded-lg border border-[#0e0f11] bg-[#0e0f11] px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:cursor-default disabled:opacity-40";
const quiet =
  "cursor-pointer text-[13px] font-medium text-[#595959] underline-offset-2 hover:text-[#0e0f11] hover:underline disabled:cursor-default disabled:opacity-50";

async function messageOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
  const e = body.error;
  return (typeof e === "string" ? e : e?.message) || fallback;
}

export async function createBoard(name: string, description: string): Promise<{ board: PinterestBoardOption } | { error: string }> {
  try {
    const res = await apiFetch(BOARDS_URL, {
      method: "POST",
      body: JSON.stringify({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) }),
    });
    if (!res.ok) return { error: await messageOf(res, "Pinterest refused to make this board. Try again in a minute.") };
    const body = (await res.json()) as { board?: PinterestBoardOption };
    return body.board?.id ? { board: body.board } : { error: "Pinterest did not confirm the board. Reload your boards before trying again." };
  } catch {
    return { error: "Zavi could not reach Pinterest just now. Reload your boards before trying again." };
  }
}

export async function searchBoards(q: string): Promise<{ boards: PinterestBoardOption[]; complete: boolean } | { error: string }> {
  try {
    const res = await apiFetch(`${BOARDS_URL}/search?${new URLSearchParams({ q: q.trim() })}`);
    if (!res.ok) return { error: await messageOf(res, "Zavi could not search your Pinterest boards just now. Try again in a minute.") };
    const body = (await res.json()) as { boards?: PinterestBoardOption[]; complete?: boolean };
    return { boards: Array.isArray(body.boards) ? body.boards : [], complete: body.complete !== false };
  } catch {
    return { error: "Zavi could not search your Pinterest boards just now. Try again in a minute." };
  }
}

export function NewPinterestBoard({
  onCreated,
  disabled = false,
  label = "New board",
}: {
  onCreated: (board: PinterestBoardOption) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim().length > 0 && name.trim().length <= NAME_MAX && description.trim().length <= DESCRIPTION_MAX;

  if (!open) {
    return (
      <button type="button" className={quiet} disabled={disabled} onClick={() => setOpen(true)} data-testid="pinterest-new-board">
        {label}
      </button>
    );
  }

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const r = await createBoard(name, description);
    setBusy(false);
    if ("error" in r) {
      setError(r.error);
      return;
    }
    setOpen(false);
    setName("");
    setDescription("");
    onCreated(r.board);
  };

  return (
    <div className="mt-2 flex w-full flex-col gap-2 rounded-lg border border-[#e5e7eb] bg-[#fbfaf7] p-3" data-testid="pinterest-new-board-form">
      <label htmlFor="pinterest-new-board-name" className="text-[13px] font-semibold text-[#1f1f1f]">
        Board name
      </label>
      <input
        id="pinterest-new-board-name"
        className={input}
        value={name}
        maxLength={NAME_MAX}
        disabled={busy || disabled}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <label htmlFor="pinterest-new-board-description" className="text-[13px] font-semibold text-[#1f1f1f]">
        Board description (optional)
      </label>
      <input
        id="pinterest-new-board-description"
        className={input}
        value={description}
        maxLength={DESCRIPTION_MAX}
        disabled={busy || disabled}
        onChange={(e) => setDescription(e.target.value)}
      />
      <p className="text-[13px] leading-5 text-[#8a8a8a]">Zavi makes it a public board on your connected Pinterest account.</p>
      {error ? (
        <p role="alert" className="rounded-lg bg-[#fdebec] px-3 py-2 text-[13px] text-[#b4232a]">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <button type="button" className={action} disabled={!valid || busy || disabled} onClick={() => void submit()}>
          {busy ? "Making the board" : "Make board"}
        </button>
        <button
          type="button"
          className={quiet}
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function FindPinterestBoard({ onFound, disabled = false }: { onFound: (boards: PinterestBoardOption[]) => void; disabled?: boolean }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = async () => {
    if (!q.trim() || busy) return;
    setBusy(true);
    setNote(null);
    const r = await searchBoards(q);
    setBusy(false);
    if ("error" in r) {
      setNote(r.error);
      return;
    }
    if (r.boards.length === 0) {
      setNote(r.complete ? "No public board with that name on your Pinterest account." : "No public board in the first results. Try a longer part of the board's name.");
      return;
    }
    setNote(r.boards.length === 1 ? null : `Found ${r.boards.length} boards. Pick one from the list.`);
    onFound(r.boards);
  };

  return (
    <div className="mt-2 flex w-full flex-col gap-2" data-testid="pinterest-find-board">
      <label htmlFor="pinterest-find-board" className="text-[13px] font-semibold text-[#1f1f1f]">
        Find a board by name
      </label>
      <div className="flex items-center gap-2">
        <input
          id="pinterest-find-board"
          className={input}
          value={q}
          maxLength={NAME_MAX}
          disabled={busy || disabled}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
        />
        <button type="button" className={action} disabled={!q.trim() || busy || disabled} onClick={() => void run()}>
          {busy ? "Searching" : "Search"}
        </button>
      </div>
      {note ? <p className="text-[13px] leading-5 text-[#595959]">{note}</p> : null}
    </div>
  );
}
