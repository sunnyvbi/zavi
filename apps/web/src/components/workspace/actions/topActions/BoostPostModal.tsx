"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AdsFormSkeleton } from "../managed-campaigns/AdsLoading";
import { newRequestId } from "@/lib/workspace/channelActionsApi";
import { startReconnectFlow } from "@/components/workspace/settings/reconnectFlows";
import { upgradeOnPlanRefusal, useChannelPlanLock } from "../channelPlanLock";
import { ActionModal, MDone, MField, m } from "./ActionModal";
import { createBoostAd, mostEngaged, readBoostOptions, type BoostOptions } from "./api";

const RECONNECT_FIXES = new Set(["connector_missing", "page_permission_missing", "page_posts_permission_missing", "token_expired"]);

const RETRY_FIXES = new Set(["lookup_failed", "meta_busy"]);

export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function BoostPostModal({ channelName, onClose, onChanged }: { channelName: string; onClose: () => void; onChanged: () => void }) {
  const planLock = useChannelPlanLock();
  const [opts, setOpts] = useState<BoostOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string>("");
  const [postId, setPostId] = useState<string>("");
  const [adSetId, setAdSetId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ url: string } | null>(null);
  const requestId = useRef(newRequestId());
  const latest = useRef({ planLock, onClose });
  latest.current = { planLock, onClose };

  const load = useCallback(
    async (page?: string) => {
      setLoadError(null);
      try {
        const o = await readBoostOptions(page);
        setOpts(o);
        if (o.eligible) {
          setPageId(o.page_id);
          setPostId(mostEngaged(o.posts)?.id ?? "");
          setAdSetId((cur) => (o.ad_sets.some((s) => s.id === cur) ? cur : (o.ad_sets.find((s) => /^active$/i.test(s.status ?? "")) ?? o.ad_sets[0])?.id ?? ""));
        }
      } catch (e) {
        if (upgradeOnPlanRefusal(latest.current.planLock, e)) {
          latest.current.onClose();
          return;
        }
        setLoadError((e as Error).message || "Zavi couldn't read your Meta account just now.");
      }
    },
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await createBoostAd({ page_id: pageId, post_id: postId, ad_set_id: adSetId, request_id: requestId.current });
      setDone({ url: r.ads_manager_url });
      onChanged();
    } catch (e) {
      if (upgradeOnPlanRefusal(planLock, e)) {
        onClose();
        return;
      }
      setError((e as Error).message || "Meta did not create the ad. Try again.");
      requestId.current = newRequestId();
    } finally {
      setBusy(false);
    }
  }

  const title = "Boost a Page post";
  const cancel = (
    <button type="button" className={m.cancel} disabled={busy} onClick={onClose}>
      Cancel
    </button>
  );

  if (opts && !opts.eligible) {
    const reconnect = RECONNECT_FIXES.has(opts.reason_code);
    return (
      <ActionModal
        eyebrow={channelName}
        title={title}
        sub="Turn a post you already published into an ad."
        onClose={onClose}
        size="md"
        hint="Your running ads keep going."
        footer={
          <>
            {cancel}
            {reconnect ? (
              <button type="button" className={m.primary} onClick={() => void startReconnectFlow("meta_ads").catch((e: Error) => setError(e.message))}>
                Reconnect Meta Ads
              </button>
            ) : RETRY_FIXES.has(opts.reason_code) ? (
              <button type="button" className={m.primary} onClick={() => void load()}>
                Try again
              </button>
            ) : null}
          </>
        }
      >
        <div className={m.note}>{opts.reason}</div>
        {error && <p role="alert" className={m.error}>{error}</p>}
      </ActionModal>
    );
  }

  const ready = opts?.eligible ? opts : null;
  const posts = ready?.posts ?? [];
  const top = mostEngaged(posts);
  const page = ready?.pages.find((p) => p.id === pageId);

  return (
    <ActionModal
      eyebrow={channelName}
      title={title}
      sub="Pick a post you already published. Zavi turns it into a paused ad in the ad set you pick."
      onClose={onClose}
      busy={busy}
      hint="Created paused. Nothing spends until you turn it on."
      footer={
        <>
          {cancel}
          <button type="button" className={m.primary} disabled={!ready || !postId || !adSetId || busy} onClick={submit}>
            {busy ? "Creating…" : "Create paused ad"}
          </button>
        </>
      }
      done={
        done ? (
          <MDone
            text="Paused ad created. Turn it on in Meta Ads Manager."
            action={
              <a href={done.url} target="_blank" rel="noopener noreferrer" className={m.cancel}>
                Open in Ads Manager
              </a>
            }
          />
        ) : undefined
      }
    >
      {!opts && !loadError && <AdsFormSkeleton label="Reading your Page and ad sets…" fields={3} />}
      {loadError && (
        <div className={m.error} role="alert">
          {loadError}{" "}
          <button type="button" className="font-semibold underline" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {ready && ready.pages.length > 1 && (
        <MField label="Facebook Page" htmlFor="boost-page">
          <select
            id="boost-page"
            value={pageId}
            disabled={busy || !!done}
            onChange={(e) => {
              setPageId(e.target.value);
              setPostId("");
              void load(e.target.value);
            }}
            className={m.input}
          >
            {ready.pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </MField>
      )}
      {ready && (
        <MField label="Post">
          {posts.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[#e5e7eb] px-4 py-6 text-center text-[14px] text-[#8a8a8a]">
              {ready.posts_note ?? `${page?.name ?? "This Page"} has no posts Zavi can boost yet.`}
            </p>
          ) : (
            <div role="radiogroup" aria-label="Post" className="flex flex-col gap-2">
              {posts.map((p) => {
                const on = p.id === postId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={busy || !!done}
                    onClick={() => setPostId(p.id)}
                    className={`flex items-center gap-3 rounded-xl border p-2.5 text-left transition-colors ${on ? "border-[#0e0f11] bg-[#fbfaf7]" : "border-[#e5e7eb] hover:bg-[#fbfaf7]"}`}
                  >
                    {p.picture ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.picture} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
                    ) : (
                      <span className="h-12 w-12 shrink-0 rounded-lg bg-[#f0ede5]" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-[12px] text-[#8a8a8a]">
                        {when(p.created_time)}
                        {top?.id === p.id && !ready?.counts_hidden && <span className="rounded-md bg-[#f0ede5] px-1.5 text-[11px] font-semibold text-[#595959]">Most engagement</span>}
                      </span>
                      <span className="mt-0.5 line-clamp-1 block text-[14px] text-[#0e0f11]">{p.message ?? "A post with no text"}</span>
                      <span className="mt-0.5 flex gap-3 text-[12px] text-[#8a8a8a]">
                        {!ready?.counts_hidden && <span>{count(p.likes, "like")}</span>}
                        {!ready?.counts_hidden && <span>{count(p.comments, "comment")}</span>}
                        <span>{count(p.shares, "share")}</span>
                      </span>
                    </span>
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${on ? "border-[#0e0f11]" : "border-[#c8c8c8]"}`}>
                      {on && <span className="h-2 w-2 rounded-full bg-[#0e0f11]" />}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </MField>
      )}
      {ready && (
        <MField
          label="Ad set"
          htmlFor="boost-ad-set"
          hint={ready.ad_sets.length === 0 ? "This ad account has no ad set yet. Make one in Meta Ads Manager first." : "Zavi never creates a campaign, an ad set or a budget here."}
        >
          <select id="boost-ad-set" value={adSetId} disabled={ready.ad_sets.length === 0 || busy || !!done} onChange={(e) => setAdSetId(e.target.value)} className={m.input}>
            {ready.ad_sets.length === 0 ? (
              <option value="">No ad sets</option>
            ) : (
              ready.ad_sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.status ? ` (${s.status.toLowerCase()})` : ""}
                </option>
              ))
            )}
          </select>
        </MField>
      )}
      {error && <p role="alert" className={m.error}>{error}</p>}
    </ActionModal>
  );
}
