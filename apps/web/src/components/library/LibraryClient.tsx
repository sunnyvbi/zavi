"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import {
  ARTIFACT_KINDS,
  artifactKind,
  formatBytes,
  formatCreatedAt,
  type ArtifactKind,
} from "@/lib/library/artifactKind";

type Artifact = {
  id: string;
  run_id: string;
  filename: string;
  mime: string;
  bytes: number;
  created_at: string;
  preview_url: string | null;
};

type ListResponse = {
  enabled: boolean;
  artifacts: Artifact[];
  expires_in?: number;
};

const DEFAULT_TTL_SECONDS = 600;
const REFRESH_FRACTION = 0.8;

type Filter = "All" | ArtifactKind;

export function LibraryClient() {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("All");
  const [query, setQuery] = useState("");

  const isMounted = useRef(true);
  const ttlMsRef = useRef(DEFAULT_TTL_SECONDS * 1000);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const res = await apiFetch("/api/run-artifacts");
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        if (isMounted.current) setError(b?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as ListResponse;
      if (!isMounted.current) return;
      setError(null);
      setEnabled(data.enabled !== false);
      setArtifacts(Array.isArray(data.artifacts) ? data.artifacts : []);
      if (typeof data.expires_in === "number" && data.expires_in > 0) {
        ttlMsRef.current = data.expires_in * 1000;
      }
    } catch {
      if (isMounted.current) setError("Could not load your library.");
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, Math.max(30_000, ttlMsRef.current * REFRESH_FRACTION));
    };
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void load({ silent: true }).finally(schedule);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void load({ silent: true }).finally(schedule);
      }
    };

    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return artifacts.filter((a) => {
      if (filter !== "All" && artifactKind(a.mime, a.filename) !== filter) return false;
      if (q && !a.filename.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [artifacts, filter, query]);

  const presentKinds = useMemo(() => {
    const seen = new Set(artifacts.map((a) => artifactKind(a.mime, a.filename)));
    return ARTIFACT_KINDS.filter((k) => seen.has(k));
  }, [artifacts]);

  if (loading) {
    return <p className="text-[16px] text-inkMuted">Loading…</p>;
  }

  if (error) {
    return (
      <div className="rounded-xl border border-[#e6dfd2] bg-white p-4">
        <p className="text-[13px] text-red-700">{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-3 rounded-cta border border-[#e6dfd2] px-3 py-1.5 text-[13px] font-medium text-ink"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="rounded-xl border border-[#e6dfd2] bg-white p-4">
        <p className="text-[16px] text-inkMuted">
          The library isn&rsquo;t switched on for this workspace yet. Your files are
          still delivered as attachments on the chat message that produced them.
        </p>
      </div>
    );
  }

  if (artifacts.length === 0) {
    return (
      <div className="rounded-xl border border-[#e6dfd2] bg-white p-4">
        <p className="text-[16px] font-medium text-ink">Nothing here yet.</p>
        <p className="mt-1 max-w-xl text-[13px] leading-[1.55] text-inkMuted">
          When you ask an agent for a report, a deck, a spreadsheet or an image,
          the finished file lands here as well as on the chat message.
        </p>
        <a
          href="/workspace"
          className="mt-3 inline-block rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-white"
        >
          Ask an agent
        </a>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label htmlFor="library-search" className="sr-only">
          Search files by name
        </label>
        <input
          id="library-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by file name"
          className="w-full max-w-xs rounded-full border border-[#e6dfd2] bg-white px-3 py-1.5 text-[13px] text-ink placeholder:text-inkMuted"
        />
        {presentKinds.length > 1 && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by type">
            {(["All", ...presentKinds] as Filter[]).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={filter === k}
                onClick={() => setFilter(k)}
                className={
                  filter === k
                    ? "rounded-full border border-ink bg-ink px-3 py-1 text-[13px] font-medium text-white"
                    : "rounded-full border border-[#e6dfd2] bg-white px-3 py-1 text-[13px] text-inkSoft transition-colors hover:border-ink/30 hover:text-ink"
                }
              >
                {k === "All" ? "All" : `${k}s`}
              </button>
            ))}
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-[#e6dfd2] bg-white p-4 text-[16px] text-inkMuted">
          No files match that.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((a) => {
            const kind = artifactKind(a.mime, a.filename);
            return (
              <li
                key={a.id}
                className="flex items-center justify-between gap-4 rounded-xl border border-[#e6dfd2] bg-white px-4 py-3.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-[16px] font-medium tracking-tight text-ink">
                    {a.filename}
                  </p>
                  <p className="mt-0.5 text-[12px] text-inkMuted">
                    <span className="rounded bg-bone px-1.5 py-0.5">{kind}</span>
                    <span> · {formatBytes(a.bytes)}</span>
                    <span> · {formatCreatedAt(a.created_at)}</span>
                  </p>
                </div>
                {a.preview_url ? (
                  <a
                    href={a.preview_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 rounded-md border border-[#e6dfd2] px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:border-ink/40"
                  >
                    Open
                  </a>
                ) : (
                  <span
                    title="This file was stored somewhere this page cannot open. Ask the agent that made it to send it again."
                    className="shrink-0 text-[12px] text-inkMuted"
                  >
                    Can&rsquo;t open
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
