"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { TenantCommand } from "@/lib/workspace/tenantCommands";
import { CommandEditor } from "./CommandEditor";
import { SkeletonListCard } from "./Skeleton";

type EditorState =
  | { mode: "closed" }
  | { mode: "new" }
  | { mode: "edit"; command: TenantCommand };

export function CommandsList() {
  const [commands, setCommands] = useState<TenantCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ mode: "closed" });

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/commands");
      if (!res.ok) {
        setError(`commands_fetch_failed:${res.status}`);
        return;
      }
      const json = (await res.json()) as { commands?: TenantCommand[] };
      setCommands(json.commands ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleDelete(slug: string) {
    if (!confirm(`Delete command /${slug}? Members can no longer invoke it.`)) {
      return;
    }
    const res = await apiFetch(`/api/commands/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      alert(`Delete failed: ${text || res.status}`);
      return;
    }
    await refresh();
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[13px] text-inkMuted leading-[1.55]">
          Reusable skill-style commands invokable as <code>/&lt;slug&gt;</code>{" "}
          in any agent chat. Instructions get prepended to the LLM input for
          that one turn only.
        </p>
        {editor.mode === "closed" && (
          <button
            type="button"
            onClick={() => setEditor({ mode: "new" })}
            className="ml-3 shrink-0 rounded-cta bg-ink px-3 py-1.5 text-[13px] font-medium text-white hover:bg-inkSoft"
          >
            + New command
          </button>
        )}
      </div>

      {editor.mode !== "closed" && (
        <div className="mb-4 rounded-xl border border-ink/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]">
          <CommandEditor
            initial={editor.mode === "edit" ? editor.command : null}
            onSaved={async () => {
              setEditor({ mode: "closed" });
              await refresh();
            }}
            onCancel={() => setEditor({ mode: "closed" })}
          />
        </div>
      )}

      {loading ? (
        <SkeletonListCard rows={3} header={false} label="Loading commands…" />
      ) : error ? (
        <div className="rounded-xl border border-coral/30 bg-coral/5 p-3 text-[13px] text-coral">
          Failed to load commands: {error}
        </div>
      ) : commands.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink/15 bg-bone p-6 text-center text-[13px] text-inkMuted">
          No commands yet. Create your first one: type{" "}
          <code>/&lt;slug&gt; ...</code> in any agent chat to invoke it.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-ink/[0.08] bg-white shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]">
          {commands.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-3 border-b border-ink/10 px-4 py-3 last:border-b-0"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <code className="text-[13px] font-medium text-ink">
                    /{c.slug}
                  </code>
                  <span className="text-[13px] text-ink truncate">
                    {c.name}
                  </span>
                </div>
                {c.description && (
                  <div className="mt-0.5 text-[12px] text-inkMuted truncate">
                    {c.description}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setEditor({ mode: "edit", command: c })}
                className="rounded-cta border border-ink/15 px-2.5 py-1 text-[12px] text-ink hover:bg-bone"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => void handleDelete(c.slug)}
                className="rounded-cta border border-coral/40 px-2.5 py-1 text-[12px] text-coral hover:bg-coral/5"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
