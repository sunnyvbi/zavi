"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { trackEvent } from "@/lib/analytics/events";
import { fetchLivePricingClient, liveTier } from "@/lib/marketing/pricing";
import { Markdown } from "../../Markdown";
import { dfyImageUrl, readDoneForYou, type DfyMode, type DoneForYou } from "./api";
import { B } from "./ui";

const POLL_MS = 10_000;
const HIDE_KEY = "zavi.growth.dfy.hidden";

export function useDoneForYou(): { dfy: DoneForYou | null; reload: () => Promise<void> } {
  const [dfy, setDfy] = useState<DoneForYou | null>(null);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    const next = await readDoneForYou();
    if (alive.current && next) setDfy(next);
  }, []);
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);
  useEffect(() => {
    if (dfy?.state !== "running") return;
    const t = window.setTimeout(() => void reload(), POLL_MS + Math.floor(Math.random() * 2000));
    return () => window.clearTimeout(t);
  }, [dfy, reload]);
  return { dfy, reload };
}

export function dfyModalBody(mode: DfyMode): string {
  return mode === "visual"
    ? "Zavi makes the finished post images and caption, ready to upload. It takes about 5 minutes. Your Free plan includes one task like this."
    : "Zavi checks this itself and writes up what it found. It takes about 5 minutes. Your Free plan includes one task like this.";
}

export function DfyOffer({ onStart }: { onStart: () => void }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-rule bg-creamDeep px-4 py-2.5 text-[14px] text-ink">
      <span>Free plan: Zavi can do one task for you.</span>
      <span className="ml-auto">
        <B dark onClick={onStart}>
          Have Zavi do this
        </B>
      </span>
    </div>
  );
}

function readHidden(): string | null {
  try {
    return window.localStorage.getItem(HIDE_KEY);
  } catch {
    return null;
  }
}

function StarterAsk({ tenantId, state, onUpgrade }: { tenantId: string | null; state: string; onUpgrade: () => void }) {
  const [usd, setUsd] = useState<number | null>(null);
  const sent = useRef(false);
  useEffect(() => {
    let live = true;
    void fetchLivePricingClient().then((p) => {
      if (live) setUsd(liveTier(p, "starter").usd);
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    trackEvent("dfy_upsell_shown", { tenant_id: tenantId, state });
  }, [tenantId, state]);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-rule pt-3 text-[12.5px] text-ink">
      <span>
        On Starter, Zavi does this every week on every channel in your plan, and posts with your OK.
        {usd !== null ? ` $${usd}/mo.` : ""}
      </span>
      <span className="ml-auto">
        <B
          dark
          onClick={() => {
            trackEvent("dfy_upgrade_clicked", { tenant_id: tenantId, state });
            onUpgrade();
          }}
        >
          Upgrade to Starter
        </B>
      </span>
    </div>
  );
}

function DfyImage({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void dfyImageUrl(id).then((u) => {
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [id]);
  if (!url) return <div className="h-40 w-40 animate-pulse rounded-lg bg-rule" />;
  return (
    <div className="flex flex-col items-start gap-1">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="Post image Zavi made" className="h-40 w-40 rounded-lg object-cover" />
      <a href={url} download className="text-[12px] font-semibold text-ink underline">
        Download
      </a>
    </div>
  );
}

export function DfyBlock({ dfy, tenantId, onUpgrade }: { dfy: DoneForYou | null; tenantId: string | null; onUpgrade: () => void }) {
  const [hidden, setHidden] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => setHidden(readHidden()), []);
  if (!dfy) return null;
  const box = "mb-3 rounded-2xl border border-rule bg-cream px-4 py-3 text-[13px] text-ink";

  if (dfy.state === "running") {
    return (
      <div className={box} role="status">
        <p className="flex items-center gap-2 font-semibold">
          <Loader2 className="h-4 w-4 animate-spin" /> Zavi is doing this…
        </p>
        <p className="mt-1 text-[12.5px] text-inkMuted">Your other cards stay open while it works.</p>
      </div>
    );
  }

  if (dfy.state === "done") {
    if (dfy.run_id && hidden === dfy.run_id) return null;
    const r = dfy.result;
    return (
      <div className={box}>
        <div className="flex items-center gap-2">
          <p className="font-bold">Zavi&apos;s free task</p>
          <button
            type="button"
            className="ml-auto text-[12px] text-inkMuted underline"
            onClick={() => {
              try {
                if (dfy.run_id) window.localStorage.setItem(HIDE_KEY, dfy.run_id);
              } catch {}
              setHidden(dfy.run_id);
            }}
          >
            Hide
          </button>
        </div>
        {r?.markdown ? <Markdown source={r.markdown} disableActionLinks compact className="mt-2" /> : null}
        {r && r.images.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-3">
            {r.images.map((i) => (
              <DfyImage key={i.id} id={i.id} />
            ))}
          </div>
        )}
        {r?.caption && (
          <div className="mt-3 rounded-xl border border-rule bg-creamDeep px-3 py-2">
            <p className="whitespace-pre-wrap text-[12.5px]">{r.caption}</p>
            <button
              type="button"
              className="mt-1 text-[12px] font-semibold underline"
              onClick={() => {
                void navigator.clipboard?.writeText(r.caption ?? "").then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
        <p className="mt-2 text-[12px] text-inkMuted">Done by Zavi.</p>
        <StarterAsk tenantId={tenantId} state={dfy.state} onUpgrade={onUpgrade} />
      </div>
    );
  }

  if (dfy.state === "used_up") {
    return (
      <div className={box}>
        <p>Zavi couldn&apos;t finish a free task this time.</p>
        <StarterAsk tenantId={tenantId} state={dfy.state} onUpgrade={onUpgrade} />
      </div>
    );
  }

  if (dfy.state === "available" && dfy.last_outcome === "cannot_do") {
    return (
      <div className={box}>
        {}
        <p>Zavi couldn&apos;t finish that one, and your free task wasn&apos;t used.</p>
      </div>
    );
  }
  if (dfy.state === "available" && dfy.last_outcome === "failed") {
    return (
      <div className={box}>
        <p>That didn&apos;t finish. Your free task wasn&apos;t used. Try again.</p>
      </div>
    );
  }
  return null;
}
