"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { AddKnowledgeButton, showAddKnowledge } from "../setup/AddKnowledgeDialog";
import { useSetupOptional } from "../setup/SetupProvider";
import { BTN_TEXT, errorMessageOf, Section } from "./shared";

type Fact = { id: string; text: string; quote: string; line: number | null };
type ImportFile = {
  id: string;
  filename: string;
  size_bytes: number;
  extraction: { state?: string; facts?: number; reason?: string } | null;
  facts: Fact[];
};

export function ImportedKnowledgeSection({ readOnly }: { readOnly: boolean }) {
  const [files, setFiles] = useState<ImportFile[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setup = useSetupOptional();
  const canAdd = !readOnly && showAddKnowledge(setup?.state ?? null, setup?.canManageSetup ?? false);

  const load = useCallback(async (cursor: string | null = null) => {
    if (readOnly) return;
    try {
      const res = await apiFetch(`/api/knowledge/imports${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      const body = (await res.json().catch(() => null)) as { files?: ImportFile[]; next_cursor?: string | null } | null;
      if (!res.ok) throw new Error(errorMessageOf(body, `HTTP ${res.status}`));
      if (!cursor) setError(null);
      setFiles((prev) => (cursor ? [...(prev ?? []), ...(body?.files ?? [])] : body?.files ?? []));
      setNext(body?.next_cursor ?? null);
    } catch (e) {
      setError((e as Error).message);
      setFiles((prev) => prev ?? []);
    }
  }, [readOnly]);
  useEffect(() => { void load(); }, [load]);

  const importsKey = setup?.imports?.files?.map((f) => `${f.id}:${f.status}`).join(",") ?? null;
  const seenKey = useRef(importsKey);
  useEffect(() => {
    if (importsKey === seenKey.current) return;
    seenKey.current = importsKey;
    if (importsKey !== null) void load();
  }, [importsKey, load]);

  const act = async (method: "DELETE", path: string) => {
    setError(null);
    const res = await apiFetch(path, { method });
    if (!res.ok) setError(errorMessageOf(await res.json().catch(() => null), `HTTP ${res.status}`));
    await load();
  };
  const download = async (id: string) => {
    const res = await apiFetch(`/api/personalization/documents/${id}/url`);
    const body = (await res.json().catch(() => null)) as { url?: string } | null;
    if (res.ok && body?.url) window.open(body.url, "_blank", "noopener,noreferrer");
  };

  if (readOnly || !files || (files.length === 0 && !error && !canAdd)) return null;
  return (
    <Section id="imported-files" title="Imported files" description="Past work you gave Zavi, and the facts each file taught it. Agents use the facts; the files themselves stay private to you.">
      {error && <p role="alert" className="mb-2 text-[14px] text-warn dark:text-marigold">{error}</p>}
      <ul className="divide-y divide-rule">
        {files.map((f) => (
          <li key={f.id} className="py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[16px] font-medium text-ink">{f.filename}</span>
              <span className="text-[13px] text-inkMuted">
                {f.extraction?.state === "read" ? `${f.facts.length} ${f.facts.length === 1 ? "fact" : "facts"}` : f.extraction?.state === "stored" ? "Saved, not read (image)" : f.extraction?.reason ? `Couldn't read this one (${f.extraction.reason})` : setup?.imports?.files?.some((x) => x.id === f.id && x.status === "reading") ? "Reading..." : "Not read"}
              </span>
              {f.facts.length > 0 && (
                <button type="button" className={BTN_TEXT} onClick={() => setOpen(open === f.id ? null : f.id)}>
                  {open === f.id ? "Hide" : "See facts"}
                </button>
              )}
              <button type="button" className={BTN_TEXT} onClick={() => void download(f.id)}>Download</button>
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`Remove ${f.filename}`}
                  className={BTN_TEXT}
                  onClick={async () => {
                    if (await confirmAction({ title: `Remove ${f.filename}?`, description: "The file and every fact it gave are removed. Agents stop using them.", confirmLabel: "Remove", tone: "danger" }))
                      void act("DELETE", `/api/knowledge/imports/${f.id}`);
                  }}
                >
                  Remove
                </button>
              )}
            </div>
            {open === f.id && (
              <ul className="mt-2 space-y-2 border-l-2 border-rule pl-3">
                {f.facts.map((x) => (
                  <li key={x.id} className="flex items-start gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] text-ink">{x.text}</span>
                      <span className="block text-[12px] text-inkMuted">{`${f.filename}${x.line ? `, line ${x.line}` : ""}: “${x.quote}”`}</span>
                    </span>
                    {!readOnly && (
                      <button type="button" aria-label={`Remove fact: ${x.text}`} className={BTN_TEXT} onClick={() => void act("DELETE", `/api/knowledge/facts/${x.id}`)}>
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {next && (
        <button type="button" className={`${BTN_TEXT} mt-2`} onClick={() => void load(next)}>
          Show more
        </button>
      )}
      {canAdd && <AddKnowledgeButton onClose={() => void load()} />}
    </Section>
  );
}
