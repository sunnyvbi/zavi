'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

type Props = { runId: string };

type LinkStatus = {
  status: 'published' | 'blocked' | 'revoked' | 'expired' | 'none';
  url?: string;
};

export function PrototypeLinkChip({ runId }: Props) {
  const [link, setLink] = useState<LinkStatus | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const fetchStatus = async (attempt: number) => {
      try {
        const res = await apiFetch(
          `/api/workspace/prototype-link/${encodeURIComponent(runId)}`,
        );
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as LinkStatus;
        if (data.status === 'none' && attempt === 0) {
          retryTimer = setTimeout(() => void fetchStatus(1), 4000);
          return;
        }
        setLink(data);
      } catch {
      }
    };
    void fetchStatus(0);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [runId]);

  if (!link || link.status === 'none') return null;

  if (link.status !== 'published' || !link.url) {
    const label =
      link.status === 'blocked'
        ? 'Public link withheld (content check)'
        : link.status === 'revoked'
          ? 'Public link revoked'
          : 'Public link expired';
    return (
      <span className="inline-flex items-center rounded-md bg-gray-100 px-3 py-1.5 text-xs text-gray-500">
        {label}
      </span>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url as string);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
    }
  };

  const revoke = async () => {
    try {
      const res = await apiFetch(
        `/api/workspace/prototype-link/${encodeURIComponent(runId)}/revoke`,
        { method: 'POST' },
      );
      if (res.ok) setLink({ status: 'revoked' });
    } catch {
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => void copy()}
        className="inline-flex items-center rounded-cta bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
        title={link.url}
      >
        {copied ? 'Link copied ✓' : 'Copy prototype link'}
      </button>
      <a
        href={link.url}
        target="_blank"
        rel="noreferrer noopener"
        className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
      >
        Open
      </a>
      <button
        type="button"
        onClick={() => void revoke()}
        className="text-xs text-gray-400 hover:text-gray-600"
        title="Revoke the public link (immediate)"
      >
        Revoke
      </button>
    </span>
  );
}
