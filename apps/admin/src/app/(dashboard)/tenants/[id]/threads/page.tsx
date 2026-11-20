"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { adminApiFetch } from "@/lib/api-admin";
import {
  TenantBackLink,
  TenantLabel,
  type TenantIdentity,
} from "@/components/admin/TenantIdentity";

type ThreadItem = {
  id: string;
  agent_slug: string;
  user_id: string | null;
  title: string | null;
  created_at: string;
  last_message_at: string;
  synthetic: boolean;
  message_count: number;
};

type ListResp = {
  items: ThreadItem[];
  has_more: boolean;
  next_offset: number | null;
};

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function TenantThreadsPage() {
  const params = useParams<{ id: string }>();
  const tenantId = params?.id;

  const [items, setItems] = useState<ThreadItem[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [hasMore, setHasMore] = useState(false);
  const [slugFilter, setSlugFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tenant] = useState<TenantIdentity | null>(null);

  const fetchPage = useCallback(
    async (offset: number, slug: string, append: boolean) => {
      if (!tenantId) return;
      append ? setLoadingMore(true) : setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ offset: String(offset), limit: "100" });
        if (slug) qs.set("agent_slug", slug);
        const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/threads?${qs}`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        const body = r as ListResp;
        setItems((prev) => (append ? [...prev, ...body.items] : body.items));
        setHasMore(body.has_more);
        setNextOffset(body.next_offset);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [tenantId],
  );

  useEffect(() => {
    void fetchPage(0, slugFilter, false);
  }, [fetchPage, slugFilter]);

  const slugs = Array.from(new Set(items.map((t) => t.agent_slug))).sort();

  return (
    <div className="max-w-5xl mx-auto p-6">
      <TenantBackLink tenantId={tenantId} tenant={tenant} />
      <div className="mt-2 mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-sky-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Chat threads</h1>
        <p className="text-sm text-slate-500 mt-1">
          <TenantLabel tenantId={tenantId} tenant={tenant} /> · read what the agents actually said
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}

      {slugs.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSlugFilter("")}
            className={
              "rounded px-1.5 py-0.5 text-xs " +
              (slugFilter === "" ? "bg-sky-50 text-sky-700" : "bg-slate-100 text-slate-500")
            }
          >
            all agents
          </button>
          {slugs.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSlugFilter(s)}
              className={
                "rounded px-1.5 py-0.5 text-xs " +
                (slugFilter === s ? "bg-sky-50 text-sky-700" : "bg-slate-100 text-slate-500")
              }
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-slate-500">Loading threads…</div>
      ) : items.length === 0 ? (
        <div className="glass-card border-dashed p-4 text-sm text-slate-500">
          No chat threads for this tenant.
        </div>
      ) : (
        <>
          <div className="glass-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-white/50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                <tr>
                  <th className="text-left px-3 py-2.5">Agent</th>
                  <th className="text-left px-3 py-2.5">Thread</th>
                  <th className="text-right px-3 py-2.5">Msgs</th>
                  <th className="text-right px-3 py-2.5">Started</th>
                  <th className="text-right px-3 py-2.5">Last message</th>
                </tr>
              </thead>
              <tbody>
                {items.map((t) => (
                  <tr key={t.id} className="border-t border-slate-100 hover:bg-white/40">
                    <td className="px-3 py-2.5">
                      <span className="rounded px-1.5 py-0.5 text-xs bg-slate-100 text-slate-600">
                        {t.agent_slug}
                      </span>
                      {t.synthetic && (
                        <span className="ml-1 rounded px-1.5 py-0.5 text-xs bg-amber-50 text-amber-700">
                          synthetic
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/tenants/${tenantId}/threads/${t.id}`}
                        className="text-slate-900 hover:text-sky-700 hover:underline"
                      >
                        {t.title ?? <span className="text-slate-400">untitled</span>}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-700">{t.message_count}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-sm text-slate-500">
                      {new Date(t.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-sm text-slate-500">
                      {relTime(t.last_message_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
            <span>
              {items.length} thread{items.length === 1 ? "" : "s"} loaded
            </span>
            {hasMore && nextOffset !== null && (
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void fetchPage(nextOffset, slugFilter, true)}
                className="rounded px-2 py-1 text-xs bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
