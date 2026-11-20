import Link from "next/link";

export type TenantAttribution = {
  source: string;
  kind: "affiliate" | "from" | "utm_source" | "referrer" | "ad_network" | "direct" | "unknown";
  creator_id?: string;
  referral_code: string | null;
  clicked_at: string | null;
  source_tag: string | null;
};

const LABELS: Record<TenantAttribution["kind"], string> = {
  affiliate: "Affiliate", from: "Channel code", utm_source: "UTM",
  referrer: "Referring website", ad_network: "Ad network", direct: "Direct", unknown: "Unknown",
};

export function TenantSignupSource({ attribution }: { attribution?: TenantAttribution | null }) {
  if (attribution === undefined) return null;
  const a = attribution;
  const clickedAt = a?.clicked_at ? new Date(a.clicked_at) : null;
  const validDate = clickedAt && Number.isFinite(clickedAt.getTime());
  return (
    <section aria-label="Signup source" className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Signup source</h2>
      {!a ? <p className="mt-2 text-sm text-amber-800">Source details unavailable. Reload to try again.</p> : (
        <dl className="mt-3 grid gap-4 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-slate-500">Signup source</dt><dd>{LABELS[a.kind] ?? a.kind}
            {!["affiliate", "direct", "unknown"].includes(a.kind) && <> · {a.source}</>}
          </dd></div>
          <div><dt className="text-xs text-slate-500">Referred by</dt><dd>
            {a.kind === "affiliate" && a.creator_id
              ? <><Link className="text-sky-700 hover:underline" href={`/creator-network/creators/${encodeURIComponent(a.creator_id)}`}>{a.source}</Link><span className="ml-1 font-mono text-xs text-slate-500">· {a.creator_id.slice(0, 8)}</span></>
              : "—"}
          </dd></div>
          <div><dt className="text-xs text-slate-500">Referral code</dt><dd className="font-mono">{a.referral_code ?? "—"}</dd></div>
          <div><dt className="text-xs text-slate-500">Referral click date (UTC)</dt><dd>
            {validDate ? <time dateTime={clickedAt.toISOString()}>{clickedAt.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}</time> : "—"}
          </dd></div>
          {a.source_tag && a.kind !== "from" && <div><dt className="text-xs text-slate-500">Channel code (from)</dt><dd>{a.source_tag}</dd></div>}
        </dl>
      )}
    </section>
  );
}
