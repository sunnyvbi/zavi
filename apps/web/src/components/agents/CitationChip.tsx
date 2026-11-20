"use client";

import { useState } from "react";
import { resolveCitation, type Citation, type CitationPreview } from "@/lib/citations";

export function CitationChip({ citation }: { citation: Citation }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<CitationPreview | null>(null);

  const onClick = async () => {
    setOpen(true);
    if (!preview) {
      try {
        const p = await resolveCitation(citation);
        setPreview(p);
      } catch (e) {
        setPreview({ found: false, kind: citation.kind, ref: citation.ref });
      }
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-label={`Cited ${citation.kind === "memory_doc" ? "memory" : "agent run"}: ${citation.label}`}
        aria-haspopup="dialog"
        className="inline-flex items-center gap-1 rounded-full bg-violetSoft border border-violet px-2 py-0.5 font-mono text-[11px] text-violetDeep hover:bg-violet/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet"
      >
        <span aria-hidden>{citation.kind === "memory_doc" ? "📄" : "🤖"}</span>
        {citation.label}
      </button>
      {open && (
        <CitationPreviewPanel preview={preview} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function CitationPreviewPanel({
  preview,
  onClose,
}: {
  preview: CitationPreview | null;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Citation preview"
      className="fixed inset-0 z-40 flex items-stretch justify-end bg-ink/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <aside className="w-full max-w-md md:max-w-lg h-full bg-white border-l border-bone overflow-y-auto p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-display text-[14px] text-ink">Citation</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-cta px-2 py-1 text-[12px] text-inkMuted hover:bg-cream focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet"
          >
            ✕
          </button>
        </div>
        {!preview ? (
          <div className="text-[12px] text-inkMuted">Loading…</div>
        ) : !preview.found ? (
          <div className="rounded-block border border-bone bg-cream p-4">
            <div className="text-[13px] text-ink mb-1">Not found</div>
            <div className="font-mono text-[11px] text-inkMuted">
              {preview.kind}: {preview.ref}
            </div>
            <div className="mt-2 text-[12px] text-inkMuted">
              This {preview.kind === "memory_doc" ? "memory doc" : "agent run"} may have been deleted.
            </div>
          </div>
        ) : preview.kind === "memory_doc" ? (
          <div>
            <div className="font-mono text-[11px] text-violet mb-1">memory_doc:{preview.slug}</div>
            <pre className="whitespace-pre-wrap text-[12px] text-ink leading-[1.5]">{preview.body_markdown}</pre>
          </div>
        ) : (
          <div>
            <div className="font-mono text-[11px] text-violet mb-1">agent_run · {preview.agent_slug}</div>
            <div className="text-[11px] text-inkMuted mb-2">
              {preview.status}
              {preview.finished_at ? ` · ${new Date(preview.finished_at).toLocaleString()}` : ""}
            </div>
            <pre className="whitespace-pre-wrap text-[12px] text-ink leading-[1.5]">{preview.output_text}</pre>
          </div>
        )}
      </aside>
    </div>
  );
}
