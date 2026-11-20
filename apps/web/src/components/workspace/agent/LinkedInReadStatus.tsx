"use client";
import { CHANNEL_TAB_EVENT } from "../actions/topActions/api";

export type LinkedInReadPayload = {
  page_url?: string | null;
  publishing_connected?: boolean | null;
  publishing_account?: { name: string } | null;
  freshness?: { last_success_day: string | null; stale: boolean };
  last_day?: string | null;
  refresh?: { available?: boolean; remaining: number; cap: number; last_attempt?: { at: string; ok: boolean; message: string | null } | null };
};
const dateLabel = (day: string) => new Date(`${day.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function LinkedInReadStatus({ payload }: { payload: unknown }) {
  const d = payload as LinkedInReadPayload | null;
  if (!d || typeof d !== "object" || !("page_url" in d)) return null;
  const day = d.freshness?.last_success_day ?? d.last_day;
  const settings = () => window.dispatchEvent(new CustomEvent(CHANNEL_TAB_EVENT, { detail: { slug: "linkedin_organic", tab: "settings" } }));
  return <section aria-label="LinkedIn data and publishing" className="rounded-xl border border-ca-border p-4 text-sm text-ca-secondary space-y-2">
    <p>{d.page_url ? <>Public numbers from <a className="underline underline-offset-2" href={d.page_url} target="_blank" rel="noopener noreferrer">{d.page_url.includes("/company/") ? "your reference company page" : "your reference profile"}</a>.</> : "No reference page saved."}</p>
    <p data-testid="linkedin-freshness">{day ? <>Last saved: <time dateTime={day}>{dateLabel(day)}</time>{d.freshness?.stale ? " · Out of date" : ""}.</> : "No successful read saved yet."}</p>
    {d.refresh && <p>{d.refresh.available === false ? "Refresh allowance unavailable." : `${d.refresh.remaining} of ${d.refresh.cap} refreshes left today · resets at midnight UTC.`}</p>}
    {d.refresh?.last_attempt && <p>Last refresh attempt: <time dateTime={d.refresh.last_attempt.at}>{new Date(d.refresh.last_attempt.at).toLocaleString("en-GB", {timeZone:"UTC"})} UTC</time> · {d.refresh.last_attempt.ok ? "saved" : "unsuccessful"}.</p>}
    <p>{d.publishing_connected === true ? `Publishing profile: ${d.publishing_account?.name ?? "connected; name unavailable"}.` : d.publishing_connected === false ? "Publishing profile not connected. You can still open each draft in LinkedIn and post it yourself." : "The publishing connection could not be confirmed."}</p>
    <p>Drafts are in Overview. These public counts do not measure posts on a different profile, impressions, website visits or signups.</p>
    <button type="button" onClick={settings} className="font-medium underline underline-offset-2">Review page and publishing settings</button>
  </section>;
}
