"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { Input, Textarea } from "@/components/Input";
import { MEMORY_URL } from "@/lib/workspace/tabUrl";

export type EditorClientProps = {
  initial: {
    id: string | null;
    title: string;
    body_markdown: string;
    tags: string[];
    slug: string | null;
  };
};

export function EditorClient({ initial }: EditorClientProps) {
  const router = useRouter();
  const isAnchor = !!initial.slug;
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body_markdown);
  const [tagsRaw, setTagsRaw] = useState(initial.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [refineInstruction, setRefineInstruction] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const tags = tagsRaw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);

  async function save() {
    if (body.length === 0) {
      setErr("body required");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const path = initial.id ? `/api/memory/notes/${initial.id}` : "/api/memory/notes";
      const method = initial.id ? "PUT" : "POST";
      const res = await apiFetch(path, {
        method,
        body: JSON.stringify({ title, body_markdown: body, tags }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error?.message ?? `${res.status}`);
      }
      const json = (await res.json()) as { note_id: string };
      router.push(`/memory/${initial.id ?? json.note_id}`);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!initial.id) return;
    if (!confirm("Delete this memory note? This is permanent.")) return;
    setDeleting(true);
    setErr(null);
    try {
      const res = await apiFetch(`/api/memory/notes/${initial.id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error?.message ?? `${res.status}`);
      }
      router.push(MEMORY_URL);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      setDeleting(false);
    }
  }

  async function regenerate() {
    if (!initial.slug) return;
    if (!confirm(`Regenerate the ${initial.slug} anchor? This rewrites the body from current brain context (~$0.05).`)) return;
    setRegenerating(true);
    setErr(null);
    try {
      const trimmedRefine = refineInstruction.trim();
      const res = await apiFetch("/api/memory/regenerate-anchor", {
        method: "POST",
        body: JSON.stringify({
          slug: initial.slug,
          ...(trimmedRefine ? { refineInstruction: trimmedRefine } : {}),
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error?.message ?? `${res.status}`);
      }
      const json = (await res.json()) as { body_markdown?: string };
      if (typeof json.body_markdown === "string") {
        setBody(json.body_markdown);
      }
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <div className="space-y-5">
      {isAnchor && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
          This is the <span className="font-mono">{initial.slug}</span> anchor: a system-core memory the agents read by hardcoded slug. Direct edits + deletes are blocked. Use <span className="font-mono">Regenerate anchor</span> to rewrite the body from current brain context.
        </div>
      )}

      <div>
        <label className="block text-[11px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-1.5">
          Title
        </label>
        <Input
          unstyled
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          placeholder="(optional)"
          readOnly={isAnchor}
          className={`w-full rounded-lg border px-3.5 py-2 text-[16px] text-slate-900 placeholder:text-slate-400 focus:outline-none ${
            isAnchor
              ? "border-slate-200 bg-slate-50 cursor-not-allowed"
              : "border-slate-300 bg-white focus:border-skyMuted"
          }`}
        />
      </div>

      <div>
        <label className="block text-[11px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-1.5">
          Body (Markdown)
        </label>
        <Textarea
          unstyled
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={50_000}
          rows={20}
          placeholder="Markdown content. Will be chunked, embedded, and entity-extracted on save."
          readOnly={isAnchor}
          className={`w-full rounded-lg border px-3.5 py-2.5 font-mono text-[13px] leading-[1.6] text-slate-900 placeholder:text-slate-400 focus:outline-none ${
            isAnchor
              ? "border-slate-200 bg-slate-50 cursor-not-allowed"
              : "border-slate-300 bg-white focus:border-skyMuted"
          }`}
        />
        <div className="text-[11px] text-slate-400 font-mono mt-1 text-right">
          {body.length.toLocaleString()} / 50,000
        </div>
      </div>

      {!isAnchor && (
        <div>
          <label className="block text-[11px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-1.5">
            Tags (comma-separated, max 10)
          </label>
          <Input
            type="text"
            value={tagsRaw}
            onChange={(e) => setTagsRaw(e.target.value)}
            placeholder="onboarding, refund-policy, host-faq"
          />
        </div>
      )}

      {err && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-900">
          {err}
        </div>
      )}

      {isAnchor && (
        <div>
          <label className="block text-[11px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-1.5">
            Refine with instruction (optional)
          </label>
          <Input
            type="text"
            value={refineInstruction}
            onChange={(e) => setRefineInstruction(e.target.value)}
            maxLength={500}
            placeholder='e.g. "emphasize that we are pre-launch and B2B only"'
            disabled={regenerating}
          />
          <div className="text-[11px] text-slate-400 mt-1">
            Steer the rewrite. Left blank, it regenerates from current brain context.
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-2">
        {isAnchor ? (
          <button
            type="button"
            onClick={regenerate}
            disabled={regenerating}
            className="rounded-cta bg-skyMuted text-white px-4 py-2 text-[13px] font-medium hover:bg-brickDark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {regenerating ? "Regenerating…" : "Regenerate anchor"}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={save}
              disabled={saving || body.length === 0}
              className="rounded-cta border border-transparent bg-skyMuted text-white px-4 py-2 text-[13px] font-medium hover:bg-brickDark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Saving…" : initial.id ? "Save changes" : "Create note"}
            </button>
            {initial.id && (
              <button
                type="button"
                onClick={remove}
                disabled={deleting || saving}
                className="rounded-cta border border-red-200 bg-white text-red-700 px-4 py-2 text-[13px] font-medium hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
