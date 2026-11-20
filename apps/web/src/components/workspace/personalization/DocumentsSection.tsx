"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { uploadErrorMessage } from "@/lib/workspace/uploadErrorMessage";
import { Skeleton } from "../Skeleton";
import { BTN_SECONDARY, BTN_TEXT, errorMessageOf, Section, Updated } from "./shared";

const MAX_DOCUMENT_MB = 25;

type Doc = {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  status: "approved" | "archived";
  version: number;
  created_at: string;
  updated_at: string;
};

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function DocumentsSection({ readOnly }: { readOnly: boolean }) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const addRef = useRef<HTMLInputElement | null>(null);
  const replaceRef = useRef<HTMLInputElement | null>(null);
  const replaceTarget = useRef<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch("/api/personalization/documents");
      const body = (await res.json().catch(() => null)) as { documents?: Doc[] } | null;
      if (!res.ok) throw new Error(errorMessageOf(body, `HTTP ${res.status}`));
      setDocs(body?.documents ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load documents.");
      setDocs([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(path: string, file: File, id: string) {
    setRowError(null);
    if (file.size > MAX_DOCUMENT_MB * 1024 * 1024) {
      setRowError({ id, message: `Couldn't upload ${file.name}: the file is too large (max ${MAX_DOCUMENT_MB}MB).` });
      return;
    }
    setBusy(id);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      let res: Response;
      try {
        res = await apiFetch(path, { method: "POST", body: form, retryOnNetworkError: false });
      } catch (e) {
        setRowError({ id, message: uploadErrorMessage(file.name, MAX_DOCUMENT_MB, { kind: "thrown", error: e }) });
        return;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setRowError({
          id,
          message: uploadErrorMessage(file.name, MAX_DOCUMENT_MB, { kind: "http", status: res.status, body: text }),
        });
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function act(id: string, method: "POST" | "DELETE", path: string) {
    setBusy(id);
    setRowError(null);
    try {
      const res = await apiFetch(path, { method });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorMessageOf(body, `HTTP ${res.status}`));
      await load();
    } catch (e) {
      setRowError({ id, message: e instanceof Error ? e.message : "Action failed." });
    } finally {
      setBusy(null);
    }
  }

  async function view(id: string) {
    setBusy(id);
    setRowError(null);
    try {
      const res = await apiFetch(`/api/personalization/documents/${id}/url`);
      const body = (await res.json().catch(() => null)) as { url?: string } | null;
      if (!res.ok || !body?.url) throw new Error(errorMessageOf(body, `HTTP ${res.status}`));
      window.open(body.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setRowError({ id, message: e instanceof Error ? e.message : "Could not open the file." });
    } finally {
      setBusy(null);
    }
  }

  const approved = docs?.filter((d) => d.status === "approved") ?? [];
  const archived = docs?.filter((d) => d.status === "archived") ?? [];

  const row = (d: Doc) => (
    <li key={d.id} className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[16px] font-medium leading-5 text-ink">{d.filename}</p>
          <p className="text-[13px] leading-[18px] text-inkMuted">
            {fmtSize(d.size_bytes)} · v{d.version} · <Updated at={d.updated_at} />
            {d.status === "archived" ? " · Archived" : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => void view(d.id)} disabled={busy === d.id} className={BTN_TEXT}>
            View
          </button>
          {!readOnly ? (
            <>
              {d.status === "approved" ? (
                <>
                  <button
                    type="button"
                    disabled={busy === d.id}
                    className={BTN_TEXT}
                    onClick={() => {
                      replaceTarget.current = d.id;
                      replaceRef.current?.click();
                    }}
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    disabled={busy === d.id}
                    className={BTN_TEXT}
                    onClick={() => void act(d.id, "POST", `/api/personalization/documents/${d.id}/archive`)}
                  >
                    Archive
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={busy === d.id}
                  className={BTN_TEXT}
                  onClick={() => void act(d.id, "POST", `/api/personalization/documents/${d.id}/restore`)}
                >
                  Restore
                </button>
              )}
              <button
                type="button"
                disabled={busy === d.id}
                className={BTN_TEXT}
                onClick={() => {
                  if (window.confirm(`Remove ${d.filename}? Agents will no longer see it.`)) {
                    void act(d.id, "DELETE", `/api/personalization/documents/${d.id}`);
                  }
                }}
              >
                Remove
              </button>
            </>
          ) : null}
        </div>
      </div>
      {rowError?.id === d.id ? (
        <p role="alert" className="mt-1 text-[13px] text-ink">
          {rowError.message}
        </p>
      ) : null}
    </li>
  );

  return (
    <Section
      id="documents"
      title="Documents and files"
      description={
        "Reference files your agents can open when relevant, like brand guides, price lists and policies. Zavi doesn't read these into what it knows." +
        (readOnly ? "" : " To teach Zavi from a file, use Add knowledge under Imported files.")
      }
      aside={
        !readOnly ? (
          <button type="button" onClick={() => addRef.current?.click()} disabled={busy === "new"} className={BTN_SECONDARY}>
            {busy === "new" ? "Uploading…" : "Add file"}
          </button>
        ) : null
      }
    >
      <input
        ref={addRef}
        type="file"
        className="hidden"
        aria-label="Add a document"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void send("/api/personalization/documents", f, "new");
        }}
      />
      <input
        ref={replaceRef}
        type="file"
        className="hidden"
        aria-label="Replace a document"
        onChange={(e) => {
          const f = e.target.files?.[0];
          const id = replaceTarget.current;
          e.target.value = "";
          replaceTarget.current = null;
          if (f && id) void send(`/api/personalization/documents/${id}/replace`, f, id);
        }}
      />
      {docs === null ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" rounded="rounded-[10px]" />
          <Skeleton className="h-10 w-full" rounded="rounded-[10px]" />
        </div>
      ) : error ? (
        <p role="alert" className="text-[13px] text-ink">
          {error}
        </p>
      ) : docs.length === 0 ? (
        <p className="text-[13px] text-inkMuted">No files yet. PDF, Word, Excel, PowerPoint, text, CSV and images up to 25 MB.</p>
      ) : (
        <>
          {rowError?.id === "new" ? (
            <p role="alert" className="mb-2 text-[13px] text-ink">
              {rowError.message}
            </p>
          ) : null}
          <ul className="divide-y divide-rule">{approved.map(row)}</ul>
          {archived.length > 0 ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-[13px] font-medium text-inkMuted">
                Archived ({archived.length})
              </summary>
              <ul className="divide-y divide-rule">{archived.map(row)}</ul>
            </details>
          ) : null}
        </>
      )}
      {docs !== null && docs.length === 0 && rowError?.id === "new" ? (
        <p role="alert" className="mt-2 text-[13px] text-ink">
          {rowError.message}
        </p>
      ) : null}
    </Section>
  );
}
