"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { fileFromServer, type ImportFile, type ServerFile } from "./importReadState";

export { summarizeReads, namesOf, type ImportFile, type ReadSummary } from "./importReadState";

export const IMPORT_POLL_MS = 4_000;
export const KICK_AFTER_MS = 20_000;

export type ImportReads = {
  files: ImportFile[] | null;
  refresh: () => Promise<void>;
  failures?: number;
};

const MAX_FAILURES = 15;
const SLOW_POLL_MS = 60_000;

export function useImportReads(enabled: boolean): ImportReads {
  const [files, setFiles] = useState<ImportFile[] | null>(null);
  const [failures, setFailures] = useState(0);
  const alive = useRef(true);
  const kicked = useRef(new Set<string>());
  const inFlight = useRef(0);
  const refresh = useCallback(async () => {
    inFlight.current += 1;
    try {
      const res = await apiFetch("/api/knowledge/imports");
      const body = res.ok ? ((await res.json().catch(() => null)) as { files?: ServerFile[] } | null) : null;
      if (!alive.current) return;
      if (!body?.files) {
        setFailures((n) => n + 1);
        return;
      }
      const now = Date.now();
      setFiles(body.files.map((f) => fileFromServer(f, now)));
      setFailures(0);
    } catch {
      if (alive.current) setFailures((n) => n + 1);
    } finally {
      inFlight.current -= 1;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const asked = useRef(false);
  useEffect(() => {
    if (!enabled || asked.current) return;
    asked.current = true;
    void refresh();
  }, [enabled, refresh]);

  const reading = (files ?? []).filter((f) => f.status === "reading");
  const anyReading = reading.length > 0;
  const waiting = files === null;
  const retrying = failures > 0;
  const gaveUp = failures >= MAX_FAILURES;
  useEffect(() => {
    if (!anyReading && (gaveUp || (!(enabled && waiting) && !retrying))) return;
    const id = window.setInterval(() => {
      if (inFlight.current === 0) void refresh();
    }, gaveUp ? SLOW_POLL_MS : IMPORT_POLL_MS);
    return () => window.clearInterval(id);
  }, [enabled, anyReading, waiting, retrying, gaveUp, refresh]);

  useEffect(() => {
    const now = Date.now();
    for (const f of reading) {
      if (!f.unclaimed || kicked.current.has(f.id)) continue;
      if (now - Date.parse(f.created_at) < KICK_AFTER_MS) continue;
      kicked.current.add(f.id);
      void apiFetch(`/api/knowledge/import/${f.id}/read`, { method: "POST" }).catch(() => null);
    }
  });

  return useMemo(() => ({ files, refresh, failures }), [files, refresh, failures]);
}

export async function uploadImport(file: File): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  try {
    const form = new FormData();
    form.append("file", file, file.name);
    const up = await apiFetch("/api/personalization/documents?purpose=import", {
      method: "POST",
      body: form,
      retryOnNetworkError: false,
    });
    const body = (await up.json().catch(() => null)) as { document?: { id?: string }; error?: { message?: string } } | null;
    if (!up.ok || !body?.document?.id) return { ok: false, reason: body?.error?.message ?? "upload failed" };
    return { ok: true, id: body.document.id };
  } catch {
    return { ok: false, reason: "the connection dropped" };
  }
}

