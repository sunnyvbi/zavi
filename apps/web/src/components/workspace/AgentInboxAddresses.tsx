"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

type AgentInboxAddress = {
  agent_slug: string;
  address: string;
  from_name: string | null;
};

export function AgentInboxAddresses() {
  const [addresses, setAddresses] = useState<AgentInboxAddress[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/workspace/inbox-addresses");
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        if (!cancelled) setAddresses((body.addresses ?? []) as AgentInboxAddress[]);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return null;
  if (addresses === null) return null;

  return (
    <div className="mt-8">
      <h3 className="mb-1 text-[14px] font-semibold tracking-tight text-ink">
        Agent email addresses
      </h3>
      <p className="mb-3 text-[13px] text-inkMuted leading-[1.55]">
        Email any agent directly. Messages route into its inbox and the agent
        triages them like a teammate.
      </p>
      {addresses.length === 0 ? (
        <p className="text-[13px] text-inkMuted">
          Email isn&apos;t set up for this workspace yet. Contact your account
          team to enable per-agent inboxes.
        </p>
      ) : (
        <ul className="divide-y divide-ink/5 rounded-lg border border-ink/10 bg-white">
          {addresses.map((a) => (
            <li key={a.agent_slug} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-ink">
                  {a.from_name ?? a.agent_slug}
                </div>
                <div className="truncate font-mono text-[12px] text-inkMuted">{a.address}</div>
              </div>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(a.address).then(() => {
                    setCopied(a.agent_slug);
                    setTimeout(() => setCopied((c) => (c === a.agent_slug ? null : c)), 1200);
                  });
                }}
                className="shrink-0 rounded border border-ink/10 bg-white px-2 py-1 text-[11px] text-inkMuted hover:border-ink/30 hover:text-ink"
              >
                {copied === a.agent_slug ? "Copied" : "Copy"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
