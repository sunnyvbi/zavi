"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Globe } from "lucide-react";
import { faviconUrlFromDomain } from "@/lib/favicon";

export function toHost(raw: string): string {
  const match = raw.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);
  const host = match ? match[1] : raw.split(/\s+/)[0];
  return host.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0];
}

const SITE_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

export const FAVICON_DEBOUNCE_MS = 500;

export function SiteIcon({
  value,
  className = "",
  size = 20,
  fallback,
  delayMs = FAVICON_DEBOUNCE_MS,
  imgClassName = "rounded-[4px] object-contain",
}: {
  value: string;
  className?: string;
  size?: number;
  fallback?: ReactNode;
  delayMs?: number;
  imgClassName?: string;
}) {
  const [icon, setIcon] = useState<{ url: string; ready: boolean } | null>(null);
  const shown = icon?.url ?? null;

  useEffect(() => {
    const host = toHost(value);
    const next = SITE_RE.test(host) ? faviconUrlFromDomain(host) : null;
    if (!next) {
      setIcon(null);
      return;
    }
    if (shown === next) return;
    setIcon(null);
    const timer = window.setTimeout(() => setIcon({ url: next, ready: false }), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, shown, delayMs]);

  const box = { width: size, height: size };
  return (
    <span aria-hidden="true" className={`relative block shrink-0 ${className}`} style={box}>
      {icon && (
        <img
          key={icon.url}
          src={icon.url}
          alt=""
          width={size}
          height={size}
          onLoad={() => setIcon((cur) => (cur && cur.url === icon.url ? { ...cur, ready: true } : cur))}
          onError={() => setIcon((cur) => (cur && cur.url === icon.url ? { ...cur, ready: false } : cur))}
          className={`absolute inset-0 ${imgClassName} ${icon.ready ? "" : "opacity-0"}`}
          style={box}
        />
      )}
      {!icon?.ready && (fallback ?? <Globe style={box} />)}
    </span>
  );
}
