"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { registerSessionScopedCache } from "@/lib/workspace/sessionScopedCache";

export type GithubReposState =
  | { status: "loading" }
  | {
      status: "ok";
      connected: boolean;
      repos: string[];
      default: string | null;
      hiddenByScope: number;
      accountLogin?: string | null;
    }
  | { status: "error"; message: string };

const LOADING: GithubReposState = { status: "loading" };
let lastKnown: GithubReposState = LOADING;

function forgetGithubRepos(): void {
  lastKnown = LOADING;
}

export function readGithubRepos(): GithubReposState {
  return lastKnown;
}

export type SetDefaultResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function useGithubRepos(): {
  state: GithubReposState;
  pending: boolean;
  setDefault: (repo: string) => Promise<SetDefaultResult>;
} {
  const [state, setState] = useState<GithubReposState>({ status: "loading" });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (state.status === "loading") return;
    lastKnown = state;
    registerSessionScopedCache(forgetGithubRepos);
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sb = createBrowserSupabase();
        const tenantId = await getActiveTenantId(sb);
        if (cancelled) return;
        if (!tenantId) {
          setState({
            status: "ok",
            connected: false,
            repos: [],
            default: null,
            hiddenByScope: 0,
          });
          return;
        }
        const { data, error } = await sb
          .from("connector_metadata")
          .select(
            "slug, account_login, repo_full_names, default_repo_full_name, repo_ids, selected_repo_ids",
          )
          .eq("tenant_id", tenantId)
          .eq("slug", "github")
          .maybeSingle();
        if (cancelled) return;
        if (error) {
          setState({
            status: "error",
            message: `connector_metadata_read_failed:${error.message}`,
          });
          return;
        }
        const gh = data as {
          slug: string;
          account_login?: string | null;
          repo_full_names: string[] | null;
          default_repo_full_name: string | null;
          repo_ids: number[] | null;
          selected_repo_ids: number[] | null;
        } | null;
        const names = gh?.repo_full_names ?? [];
        const ids = gh?.repo_ids ?? null;
        const selected = gh?.selected_repo_ids ?? null;
        const canScope =
          selected !== null && !!ids && ids.length === names.length;
        const settable = canScope
          ? names.filter((_, i) => selected!.includes(ids![i]))
          : names;
        setState({
          status: "ok",
          connected: !!gh,
          repos: [...settable].sort((a, b) => a.localeCompare(b)),
          default: gh?.default_repo_full_name ?? null,
          hiddenByScope: names.length - settable.length,
          accountLogin: gh?.account_login ?? null,
        });
      } catch (e) {
        if (!cancelled) {
          setState({ status: "error", message: (e as Error).message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setDefault = useCallback(
    async (repo: string): Promise<SetDefaultResult> => {
      let prev: GithubReposState | null = null;
      setPending(true);
      setState((s) => {
        prev = s;
        return s.status === "ok" ? { ...s, default: repo } : s;
      });
      try {
        const res = await apiFetch("/api/connectors/github/default-repo", {
          method: "POST",
          body: JSON.stringify({ repo_full_name: repo }),
        });
        if (res.ok) return { ok: true };
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string };
        };
        if (prev) setState(prev);
        return {
          ok: false,
          code: body.error?.code ?? `http_${res.status}`,
          message:
            body.error?.message ??
            (res.status === 403
              ? "Only admins can change the default repo."
              : `Request failed (${res.status}).`),
        };
      } catch (e) {
        if (prev) setState(prev);
        return { ok: false, code: "network", message: (e as Error).message };
      } finally {
        setPending(false);
      }
    },
    [],
  );

  return { state, pending, setDefault };
}
