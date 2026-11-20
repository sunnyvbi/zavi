"use client";

import { useCallback, useEffect, useState } from "react";
import { BTN_PRIMARY, BTN_SECONDARY, CARD, FIELD } from "./ui";
import { dayTimeUtc } from "./hub";
import { callJson } from "./useCards";

export type Publication = {
  id: string;
  publisher: "business" | "creator";
  platform: string;
  account: string | null;
  post_url: string | null;
  status: "scheduled" | "published";
  scheduled_for: string | null;
  published_at: string | null;
  verification: "verified" | "pending" | "manual" | "failed";
  verification_note: string | null;
  verified_at: string | null;
  created_at: string;
};

const PLATFORMS: { id: string; label: string }[] = [
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" },
  { id: "youtube", label: "YouTube" },
  { id: "facebook", label: "Facebook" },
  { id: "x", label: "X" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "pinterest", label: "Pinterest" },
  { id: "other", label: "Other" },
];
const PLATFORM_LABEL = Object.fromEntries(PLATFORMS.map((p) => [p.id, p.label]));

export const VERIFY_LABEL: Record<Publication["verification"], { text: string; cls: string }> = {
  verified: { text: "Verified", cls: "bg-successBg text-success" },
  pending: { text: "Not checked yet", cls: "bg-bone text-inkMuted" },
  manual: { text: "Check manually", cls: "bg-warnBg text-warn" },
  failed: { text: "Did not match", cls: "bg-dangerBg text-danger" },
};

export function PublishCard({ orderId, first }: { orderId: string; first: string }) {
  const [rows, setRows] = useState<Publication[] | null>(null);
  const [publisher, setPublisher] = useState<"business" | "creator">("business");
  const [canRecord, setCanRecord] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<"live" | "planned">("live");
  const [platform, setPlatform] = useState("tiktok");
  const [account, setAccount] = useState("");
  const [url, setUrl] = useState("");
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await callJson<{ publisher: "business" | "creator"; can_record: boolean; publications: Publication[] }>(
      `/api/humans/orders/${encodeURIComponent(orderId)}/publications`,
    );
    if (!r.ok) {
      setLoadErr(r.message);
      return;
    }
    setLoadErr(null);
    setRows(r.data.publications);
    setPublisher(r.data.publisher);
    setCanRecord(r.data.can_record);
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setErr(null);
    const iso = when ? new Date(when).toISOString() : undefined;
    const body =
      mode === "live"
        ? { platform, account: account.trim() || undefined, post_url: url.trim(), published_at: iso }
        : { platform, account: account.trim() || undefined, scheduled_for: iso };
    const r = await callJson<{ publication: Publication }>(`/api/humans/orders/${encodeURIComponent(orderId)}/publications`, { body });
    setBusy(false);
    if (!r.ok) {
      setErr(r.message);
      return;
    }
    setRows((xs) => [...(xs ?? []), r.data.publication]);
    setAdding(false);
    setUrl("");
    setWhen("");
  };

  const recheck = async (id: string) => {
    const r = await callJson<{ publication: Publication | null }>(`/api/humans/publications/${encodeURIComponent(id)}/verify`, { body: {} });
    if (r.ok && r.data.publication) setRows((xs) => xs?.map((x) => (x.id === id ? r.data.publication! : x)) ?? xs);
    else if (!r.ok) setErr(r.message);
  };

  const who = publisher === "business" ? "You publish this video" : `${first} publishes this post`;
  const valid = mode === "live" ? url.trim().length > 0 : when.length > 0;

  return (
    <div className={`${CARD} mt-4`}>
      <p className="text-[16px] font-semibold text-ink">Where it is published</p>
      <p className="mt-0.5 text-[13px] leading-relaxed text-inkMuted">
        {who}. Approved and paid is not the same as posted: add each post so it is on record, and Zavi checks TikTok and YouTube links
        against the platform.
      </p>

      {loadErr ? <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{loadErr}</p> : null}
      {rows && rows.length === 0 ? <p className="mt-3 text-[14px] text-inkMuted">Not posted yet.</p> : null}
      {rows && rows.length > 0 ? (
        <ul className="mt-3 grid gap-2">
          {rows.map((p) => {
            const badge = p.status === "scheduled" ? { text: "Planned", cls: "bg-bone text-inkMuted" } : VERIFY_LABEL[p.verification];
            return (
              <li key={p.id} className="rounded-xl border border-rule px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[14px] font-semibold text-ink">
                    {PLATFORM_LABEL[p.platform] ?? p.platform}
                    {p.account ? <span className="font-normal text-inkMuted"> · {p.account}</span> : null}
                  </p>
                  <span className={`rounded-md px-2 py-0.5 text-[12px] font-semibold ${badge.cls}`}>{badge.text}</span>
                </div>
                <p className="mt-0.5 text-[13px] text-inkMuted">
                  {p.status === "scheduled"
                    ? `Planned for ${dayTimeUtc(p.scheduled_for)}`
                    : `Posted ${dayTimeUtc(p.published_at)}${p.verified_at ? ` · verified ${dayTimeUtc(p.verified_at)}` : ""}`}
                  {` · by ${p.publisher === "business" ? "you" : first}`}
                </p>
                {p.post_url ? (
                  <a href={p.post_url} target="_blank" rel="noopener noreferrer" className="mt-1 block truncate text-[13px] font-medium text-ink underline underline-offset-2">
                    {p.post_url}
                  </a>
                ) : null}
                {p.verification_note ? <p className="mt-1 text-[13px] leading-snug text-inkMuted">{p.verification_note}</p> : null}
                {p.post_url && (p.verification === "pending" || p.verification === "failed") ? (
                  <button type="button" onClick={() => void recheck(p.id)} className="mt-1.5 text-[13px] font-medium text-ink underline underline-offset-2">
                    Check again
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {canRecord && !adding ? (
        <button type="button" onClick={() => setAdding(true)} className={`${BTN_SECONDARY} mt-3`}>
          Add a post
        </button>
      ) : null}
      {adding ? (
        <div className="mt-3 grid gap-2.5 rounded-xl border border-rule p-3">
          <div role="radiogroup" aria-label="Posted or planned" className="inline-flex w-fit gap-0.5 rounded-xl border border-rule bg-creamDeep p-0.5">
            {(["live", "planned"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={`inline-flex h-8 items-center rounded-lg px-3 text-[13px] ${
                  mode === m ? "bg-cream font-semibold text-ink shadow-sm" : "font-medium text-inkMuted hover:text-ink"
                }`}
              >
                {m === "live" ? "It is live" : "Planned"}
              </button>
            ))}
          </div>
          <label className="block">
            <span className="text-[14px] font-medium text-ink">Platform</span>
            <select className={`${FIELD} mt-1`} value={platform} onChange={(e) => setPlatform(e.target.value)}>
              {PLATFORMS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[14px] font-medium text-ink">Account</span>
            <input className={`${FIELD} mt-1`} value={account} onChange={(e) => setAccount(e.target.value)} placeholder="@youraccount" />
          </label>
          {mode === "live" ? (
            <label className="block">
              <span className="text-[14px] font-medium text-ink">Post link</span>
              <input className={`${FIELD} mt-1`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" inputMode="url" />
            </label>
          ) : null}
          <label className="block">
            <span className="text-[14px] font-medium text-ink">{mode === "live" ? "Posted at (optional, defaults to now)" : "Planned for"}</span>
            <input type="datetime-local" className={`${FIELD} mt-1`} value={when} onChange={(e) => setWhen(e.target.value)} />
          </label>
          {err ? <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{err}</p> : null}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className={BTN_SECONDARY}>
              Not now
            </button>
            <button type="button" disabled={busy || !valid} onClick={() => void save()} className={BTN_PRIMARY}>
              {busy ? "Saving" : mode === "live" ? "Save and check" : "Save"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
