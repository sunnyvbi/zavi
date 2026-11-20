"use client";
import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type Entry = {
  run_id: string;
  tenant_id: string;
  date: string;
  source: string;
  category: string;
  status: string;
  credits: number;
  usd: number;
  over_1000: boolean;
};
export type SignupCostData = {
  since: string;
  until: string;
  excluded: number;
  workspaces: number;
  credits: number;
  usd: number;
  unfinishedRuns: number;
  missingCostRuns: number;
  otherRuns: number;
  freeOrCompedCredits: null;
  rows: {
    date: string;
    source: string;
    source_kind: string;
    runs: number;
    credits: number;
    done_for_you_credits: number;
    over_1000_runs: number;
  }[];
  entries: Entry[];
};
export function SignupCreditCosts({
  initialData,
}: {
  initialData?: SignupCostData;
}) {
  const [data, setData] = useState<SignupCostData | null>(initialData ?? null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    adminApiFetch("/api/admin/funnel/credits")
      .then(async (res) => {
        if (!res.ok) throw new Error("read failed");
        const json = await res.json();
        if (active) setData(json);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <section aria-labelledby="signup-cost-heading" className="mt-8 mb-6">
      <h2
        id="signup-cost-heading"
        className="font-display text-xl font-semibold"
      >
        New signup costs paid by Zavi
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Last 14 UTC calendar days, including today. Completed runs in each
        workspace’s first 14 days, grouped by finish date and signup source.
        Cost credits represent provider expense, not customer charges.
      </p>
      <p className="mt-2 text-sm text-slate-600">
        Includes signup previews, setup plans with refund records, the first
        goal review and retry, done-for-you, and recorded free first-build runs.
        Excludes tests, dogfood and websites on upcar.ai or zaviagent.com;
        customer subdomains stay included.
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-rose-700">
          Could not load signup costs. No partial totals are shown.
        </p>
      ) : !data ? (
        <p className="mt-3">Loading signup costs…</p>
      ) : (
        <>
          <div className="my-4 flex flex-wrap gap-6">
            <div>
              <strong className="text-2xl tabular-nums">
                {data.credits.toLocaleString()}
              </strong>{" "}
              cost credits{" "}
              <span className="text-slate-500">(${data.usd.toFixed(2)})</span>
            </div>
            <div>
              Free daily / comped usage:{" "}
              <strong>not included; allocation unavailable</strong>
            </div>
          </div>
          <p className="mb-3 text-sm text-slate-600">
            {data.excluded} workspaces excluded. {data.unfinishedRuns}{" "}
            unfinished subsidized runs and {data.missingCostRuns} runs without
            recorded cost are outside the total. {data.otherRuns} other runs are
            not classified as onboarding subsidies. Scan costs outside agent
            runs are not included.
          </p>
          <div className="overflow-x-auto rounded border border-slate-200">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {[
                    "UTC day",
                    "Signup source",
                    "Runs",
                    "Cost credits",
                    "Done-for-you credits",
                    "DFY over 1,000",
                  ].map((h) => (
                    <th key={h} className="px-3 py-2 text-left">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr
                    key={`${r.date}:${r.source_kind}:${r.source}`}
                    className="border-t"
                  >
                    <td className="px-3 py-2 whitespace-nowrap">{r.date}</td>
                    <td className="px-3 py-2">{r.source}</td>
                    <td className="px-3 py-2">{r.runs}</td>
                    <td className="px-3 py-2">{r.credits}</td>
                    <td className="px-3 py-2">{r.done_for_you_credits}</td>
                    <td className="px-3 py-2">{r.over_1000_runs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.rows.length && (
              <p className="p-4">
                No completed subsidized runs in this window.
              </p>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Done-for-you flags compare total recorded cost with 1,000 credits;
            the enforced budget is model-only, so a flag is a review signal, not
            proof of a budget violation. Total costs are never clipped.
          </p>
          <details className="mt-4">
            <summary className="cursor-pointer">
              Reconcile totals by workspace and run ({data.entries.length})
            </summary>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    {[
                      "Workspace",
                      "Run",
                      "Category",
                      "Status",
                      "Cost credits",
                    ].map((h) => (
                      <th key={h} className="p-2 text-left">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((e) => (
                    <tr key={e.run_id} className="border-t">
                      <td className="p-2">
                        <a
                          href={`/tenants/${e.tenant_id}`}
                          className="underline"
                        >
                          {e.tenant_id}
                        </a>
                      </td>
                      <td className="p-2 font-mono">{e.run_id}</td>
                      <td className="p-2">{e.category.replaceAll("_", " ")}</td>
                      <td className="p-2">{e.status}</td>
                      <td className="p-2">{e.credits}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
