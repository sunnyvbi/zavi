"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { Switch } from "@/components/ui/Switch";

export function TeamNoteSuggestionsToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    apiFetch("/api/team-notes/prefs")
      .then(async (r) => (r.ok ? ((await r.json()) as { suggestions_off?: boolean }) : null))
      .then((b) => { if (live) setOn(b ? b.suggestions_off !== true : true); })
      .catch(() => { if (live) setOn(true); });
    return () => { live = false; };
  }, []);

  async function change(next: boolean) {
    const prev = on;
    setOn(next);
    setError(null);
    try {
      const r = await apiFetch("/api/team-notes/prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestions_off: !next }),
      });
      if (!r.ok) throw new Error(String(r.status));
    } catch {
      setOn(prev);
      setError("Not saved, try again");
    }
  }

  if (on === null) return null;
  return (
    <div className="mb-6 flex flex-col gap-1">
      <Switch checked={on} label="Suggest a note to the Zavi team when a chat goes badly" onCheckedChange={(v) => void change(v)} />
      {error && <p role="alert" className="text-[13px] text-red-700">{error}</p>}
    </div>
  );
}
