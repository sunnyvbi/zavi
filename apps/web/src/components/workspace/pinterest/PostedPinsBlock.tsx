"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Pin } from "lucide-react";
import { CountPill } from "../CountPill";
import { apiFetch } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { relative } from "../layout/channelDetail";
import { SOCIAL_POSTED_EVENT } from "@/lib/workspace/socialPostEvents";
import { attemptReason, failedPostMessage } from "@/lib/workspace/socialPostWatch";

export type PostedPin = {
  id: string;
  external_url: string | null;
  updated_at: string;
  title: string;
  text: string;
  board: string | null;
  imagePath: string | null;
};

export type FailedPin = { id: string; updated_at: string; title: string; board: string | null; reason: string };

const LIMIT = 6;
const FAILED_LIMIT = 20;
const OPEN_KEY = "zavi:posted-pins-open";

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    return;
  }
}

type Row = { id: string; external_url: string | null; updated_at: string; approved_payload_snapshot: { payload?: Record<string, unknown> } | null };
type FailedRow = Row & { last_error: string | null };

export function toPostedPin(r: Row): PostedPin {
  const p = r.approved_payload_snapshot?.payload ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    id: r.id,
    external_url: r.external_url,
    updated_at: r.updated_at,
    title: str(p.title) ?? "Pin",
    text: str(p.text) ?? "",
    board: str(p.board_name),
    imagePath: str(p.image_path),
  };
}

export async function readPostedPins(limit: number | null = LIMIT + 1): Promise<PostedPin[] | null> {
  const sb = createBrowserSupabase();
  const tenantId = await getActiveTenantId(sb);
  if (!tenantId) return null;
  const query = sb
    .from("social_posts")
    .select("id, external_url, updated_at, approved_payload_snapshot")
    .eq("tenant_id", tenantId)
    .eq("channel", "pinterest_pin")
    .eq("status", "published")
    .order("updated_at", { ascending: false });
  const { data, error } = await (limit === null ? query : query.limit(limit));
  if (error) return null;
  return ((data ?? []) as Row[]).map(toPostedPin);
}

export async function readFailedPins(): Promise<FailedPin[] | null> {
  const sb = createBrowserSupabase();
  const tenantId = await getActiveTenantId(sb);
  if (!tenantId) return null;
  const { data, error } = await sb
    .from("social_posts")
    .select("id, external_url, updated_at, approved_payload_snapshot, last_error")
    .eq("tenant_id", tenantId)
    .eq("channel", "pinterest_pin")
    .eq("status", "failed")
    .order("updated_at", { ascending: false })
    .limit(FAILED_LIMIT);
  if (error) return null;
  const rows = (data ?? []) as FailedRow[];
  if (rows.length === 0) return [];
  const { data: attempts } = await sb
    .from("social_publish_attempts")
    .select("post_id, response, created_at")
    .in("post_id", rows.map((r) => r.id))
    .order("created_at", { ascending: false });
  const latest = new Map<string, unknown>();
  for (const a of (attempts ?? []) as Array<{ post_id: string; response: unknown }>) {
    if (!latest.has(a.post_id)) latest.set(a.post_id, a.response);
  }
  return rows.map((r) => {
    const pin = toPostedPin(r);
    return { id: r.id, updated_at: r.updated_at, title: pin.title, board: pin.board, reason: failedPostMessage(r.last_error, attemptReason(latest.get(r.id))) };
  });
}

function PinThumb({ path, alt }: { path: string | null; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    void (async () => {
      try {
        const res = await apiFetch(`/api/chat/image-url?path=${encodeURIComponent(path)}`);
        if (!res.ok) return;
        const d = (await res.json()) as { signed_url?: string };
        if (live && d.signed_url) setSrc(d.signed_url);
      } catch {
        return;
      }
    })();
    return () => {
      live = false;
    };
  }, [path]);
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} className="aspect-[2/3] w-full rounded-xl bg-bone object-cover transition-transform duration-300 group-hover:scale-[1.02] motion-reduce:transition-none" />
  ) : (
    <div aria-hidden className="aspect-[2/3] w-full rounded-xl bg-bone" />
  );
}

export function PostedPinsBlock({
  read = readPostedPins,
  readFailed = readFailedPins,
}: {
  read?: (limit: number | null) => Promise<PostedPin[] | null>;
  readFailed?: () => Promise<FailedPin[] | null>;
}) {
  const [pins, setPins] = useState<PostedPin[] | null>(null);
  const [notPosted, setNotPosted] = useState<FailedPin[]>([]);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  useEffect(() => setOpen(readOpen()), []);

  const load = useCallback(async () => {
    const [out, bad] = await Promise.all([read(all ? null : LIMIT + 1).catch(() => null), readFailed().catch(() => null)]);
    setNotPosted(bad ?? []);
    if (out === null) setFailed(true);
    else {
      setFailed(false);
      setPins(out);
    }
  }, [read, readFailed, all]);

  useEffect(() => {
    void load();
    const again = () => void load();
    window.addEventListener(SOCIAL_POSTED_EVENT, again);
    return () => window.removeEventListener(SOCIAL_POSTED_EVENT, again);
  }, [load]);

  const published = failed || pins === null ? [] : pins;
  if (published.length === 0 && notPosted.length === 0) return null;
  const more = !all && published.length > LIMIT;
  const shown = more ? published.slice(0, LIMIT) : published;

  return (
    <section
      aria-label="Posted to Pinterest"
      data-testid="posted-pins"
      className="mt-3 overflow-hidden rounded-2xl border border-rule bg-white px-4"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls="posted-pins-grid"
        onClick={() => {
          setOpen((o) => {
            writeOpen(!o);
            return !o;
          });
        }}
        className="-mx-4 flex w-[calc(100%+2rem)] items-center gap-2.5 px-4 py-3.5 text-left compact:pr-[4.5rem] text-[13px] font-semibold text-ink transition-colors hover:bg-creamDeep/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/30 motion-reduce:transition-none"
      >
        <Pin className="h-3.5 w-3.5 shrink-0 text-inkMuted" aria-hidden />
        <span className="min-w-0 flex-1">Posted to Pinterest</span>
        <CountPill count={shown.length} quiet testId="posted-pins-count" />
        <ChevronDown
          aria-hidden
          className={`h-4 w-4 shrink-0 text-inkLight transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div id="posted-pins-grid" className="pb-4">
          {shown.length > 0 && (
            <ul aria-label="Posted pins" className="grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {shown.map((p) => (
                <li key={p.id} className="group flex flex-col overflow-hidden rounded-xl border border-rule bg-cream p-2">
                  <div className="overflow-hidden rounded-lg">
                    <PinThumb path={p.imagePath} alt={`Pin image: ${p.title}`} />
                  </div>
                  <div className="min-w-0 px-1 pb-1 pt-2">
                    <p className="truncate text-[14px] font-medium text-ink" title={p.title}>
                      {p.title}
                    </p>
                    <p className="truncate text-[12px] text-inkMuted">
                      {[p.board ? `${p.board} board` : null, relative(p.updated_at)].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  {p.external_url && (
                    <a
                      href={p.external_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mx-1 mb-1 mt-1 inline-flex h-8 items-center justify-center gap-1 rounded-full border border-rule text-[13px] font-medium text-ink transition-colors hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
                    >
                      Open pin <span aria-hidden>↗</span>
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
          {more && (
            <button
              type="button"
              onClick={() => setAll(true)}
              className="mt-3 inline-flex h-8 items-center rounded-full border border-rule px-3 text-[13px] font-medium text-ink transition-colors hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
            >
              Show all posted pins
            </button>
          )}
          {notPosted.length > 0 && (
            <div className="mt-4">
              <p className="text-[13px] font-semibold text-ink">Didn&apos;t post</p>
              <ul aria-label="Didn't post" className="mt-2 list-none space-y-2 p-0">
                {notPosted.map((f) => (
                  <li key={f.id} className="rounded-xl border border-rule bg-cream px-3 py-2">
                    <p className="truncate text-[14px] font-medium text-ink" title={f.title}>
                      {f.title}
                    </p>
                    <p className="text-[12px] text-inkMuted">
                      {[f.board ? `${f.board} board` : null, relative(f.updated_at)].filter(Boolean).join(" · ")}
                    </p>
                    <p className="mt-1 text-[13px] leading-snug text-ink">{f.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
