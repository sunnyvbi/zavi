"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

export type TenantCommand = {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions_md: string;
  updated_at: string;
};

export type TenantSlashEntry = {
  slug: string;
  name: string;
  description: string;
};

export function toSlashEntry(c: TenantCommand): TenantSlashEntry {
  return { slug: c.slug, name: c.name, description: c.description };
}

const UNKNOWN_COMMAND_HINT =
  "Unknown command. Available: /feedback, /clear, /help, /run, /decision <uuid>, @<agent>.";

export function useTenantCommands(): {
  commands: TenantCommand[];
  loaded: boolean;
  error: string | null;
} {
  const [commands, setCommands] = useState<TenantCommand[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    if (loadingRef.current) {
      pendingRef.current = true;
      return;
    }
    loadingRef.current = true;
    try {
      do {
        pendingRef.current = false;
        try {
          const res = await apiFetch("/api/commands");
          if (!mountedRef.current) return;
          if (!res.ok) {
            setCommands([]);
            setError(`commands_fetch_failed:${res.status}`);
            setLoaded(true);
          } else {
            const json = (await res.json()) as { commands?: TenantCommand[] };
            if (!mountedRef.current) return;
            setCommands(json.commands ?? []);
            setError(null);
            setLoaded(true);
          }
        } catch (e) {
          if (!mountedRef.current) return;
          setCommands([]);
          setError((e as Error).message);
          setLoaded(true);
        }
      } while (pendingRef.current);
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    const onFocus = () => void load();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  return { commands, loaded, error };
}

export function filterTenantCommands(
  query: string,
  rows: TenantCommand[],
): TenantCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((c) => c.slug.startsWith(q));
}

export function matchTenantInvocation(
  input: string,
): { slug: string; body: string } | null {
  const m = input.match(/^\/(?<slug>[a-z][a-z0-9-]{0,39})(?:\s+(?<body>[\s\S]*))?$/);
  if (!m || !m.groups) return null;
  const slug = m.groups.slug;
  const body = (m.groups.body ?? "").trim();
  return { slug, body };
}

export function tenantCommandHint(
  value: string,
  commands: TenantCommand[],
  loaded: boolean,
  hadError: boolean,
): string | null {
  const m = matchTenantInvocation(value.trim());
  if (!m) return UNKNOWN_COMMAND_HINT;
  if (!loaded || hadError) return null;
  const known = commands.some((c) => c.slug === m.slug);
  if (!known) return UNKNOWN_COMMAND_HINT;
  return m.body.length === 0
    ? `/${m.slug} needs a message.`
    : `⏎ to run /${m.slug}.`;
}
