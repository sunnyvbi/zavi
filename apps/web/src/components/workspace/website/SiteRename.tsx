"use client";

import { useState } from "react";
import { Loader2, Pencil } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { notifyBuildSessionsChanged } from "@/lib/workspace/useBuildSessions";

export const SITE_RENAME_FAILED = "That didn't save. Try again.";

export function SiteRename({ siteId, name, onRenamed }: { siteId: string; name: string; onRenamed?: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const open = () => {
    setValue(name);
    setFailed(false);
    setEditing(true);
  };

  const save = async () => {
    const next = value.trim();
    if (!next || saving) return;
    if (next === name) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setFailed(false);
    try {
      const res = await apiFetch(`/api/workspace/autopilot/sites/${encodeURIComponent(siteId)}/name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { name?: unknown };
      setEditing(false);
      onRenamed?.(typeof body.name === "string" ? body.name : next);
      notifyBuildSessionsChanged();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={open}
        aria-label="Rename site"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-cta text-[#595959] transition-colors hover:bg-[#f4f4f4] hover:text-[#0e0f11]"
      >
        <Pencil className="h-4 w-4" aria-hidden />
      </button>
    );
  }
  return (
    <form
      className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input
        autoFocus
        aria-label="Site name"
        value={value}
        maxLength={80}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-9 min-w-0 flex-1 rounded-cta border border-rule bg-white px-3 text-[14px] text-[#0e0f11]"
      />
      <button type="submit" disabled={saving || !value.trim()} className="inline-flex h-9 items-center gap-2 rounded-cta bg-ink px-3 text-[13px] font-semibold text-cream disabled:opacity-50">
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
        Save
      </button>
      <button type="button" disabled={saving} onClick={() => setEditing(false)} className="inline-flex h-9 items-center rounded-cta border border-rule px-3 text-[13px] text-[#0e0f11]">
        Cancel
      </button>
      {failed && <p role="alert" className="w-full text-[12px] text-[#595959]">{SITE_RENAME_FAILED}</p>}
    </form>
  );
}
