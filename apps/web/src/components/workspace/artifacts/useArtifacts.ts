"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { apiFetch } from "@/lib/api";
import type { Artifact, ArtifactsResponse, SiteArtifact } from "./types";

type State = {
  artifacts: Artifact[];
  sites: SiteArtifact[];
  loading: boolean;
  error: string | null;
  busyId: string | null;
};

type Action =
  | { type: "loading" }
  | { type: "loaded"; artifacts: Artifact[]; sites: SiteArtifact[] }
  | { type: "failed"; message: string }
  | { type: "busy"; id: string | null }
  | { type: "updated"; artifact: Artifact }
  | { type: "deleted"; id: string }
  | { type: "clear-error" };

const INITIAL_STATE: State = {
  artifacts: [],
  sites: [],
  loading: true,
  error: null,
  busyId: null,
};

export const ARTIFACTS_CACHE_FRESH_MS = 8 * 60 * 1000;
let cached: { artifacts: Artifact[]; sites: SiteArtifact[]; at: number } | null = null;

function warmState(): State {
  if (cached && Date.now() - cached.at < ARTIFACTS_CACHE_FRESH_MS) {
    return { ...INITIAL_STATE, artifacts: cached.artifacts, sites: cached.sites, loading: false };
  }
  return INITIAL_STATE;
}

function remember(artifacts: Artifact[], sites: SiteArtifact[]): void {
  cached = { artifacts, sites, at: Date.now() };
}

function rememberChange(change: (artifacts: Artifact[]) => Artifact[]): void {
  if (cached) cached = { ...cached, artifacts: change(cached.artifacts) };
}

export function resetArtifactsCacheForTests(): void {
  cached = null;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "loading":
      return { ...state, loading: true, error: null };
    case "loaded":
      return { ...state, artifacts: action.artifacts, sites: action.sites, loading: false, error: null };
    case "failed":
      return { ...state, loading: false, busyId: null, error: action.message };
    case "busy":
      return { ...state, busyId: action.id };
    case "updated": {
      const artifacts = state.artifacts.map((item) =>
        item.id === action.artifact.id ? action.artifact : item,
      );
      return { ...state, busyId: null, artifacts };
    }
    case "deleted": {
      const artifacts = state.artifacts.filter((item) => item.id !== action.id);
      return { ...state, busyId: null, artifacts };
    }
    case "clear-error":
      return { ...state, error: null };
  }
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => null) as
    | { error?: { message?: string } }
    | null;
  return payload?.error?.message ?? fallback;
}

export function useArtifacts() {
  const [state, dispatch] = useReducer(reducer, undefined, warmState);
  const warm = useRef(!state.loading);

  const load = useCallback(async (signal?: AbortSignal, silent = false) => {
    if (!silent) dispatch({ type: "loading" });
    try {
      const response = await apiFetch("/api/run-artifacts", { signal });
      if (!response.ok) {
        dispatch({
          type: "failed",
          message: await errorMessage(response, "Could not load your artifacts."),
        });
        return;
      }
      const payload = await response.json() as ArtifactsResponse;
      const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
      const sites = Array.isArray(payload.sites) ? payload.sites : [];
      remember(artifacts, sites);
      dispatch({ type: "loaded", artifacts, sites });
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        dispatch({ type: "failed", message: "Could not load your artifacts." });
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal, warm.current);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(undefined, true);
    }, 8 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [load]);

  const rename = useCallback(async (id: string, title: string): Promise<boolean> => {
    dispatch({ type: "busy", id });
    try {
      const response = await apiFetch(`/api/run-artifacts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      if (!response.ok) {
        dispatch({ type: "failed", message: await errorMessage(response, "Could not rename artifact.") });
        return false;
      }
      const payload = await response.json() as { artifact: Artifact };
      rememberChange((list) => list.map((item) => (item.id === payload.artifact.id ? payload.artifact : item)));
      dispatch({ type: "updated", artifact: payload.artifact });
      return true;
    } catch {
      dispatch({ type: "failed", message: "Could not rename artifact." });
      return false;
    }
  }, []);

  const remove = useCallback(async (id: string): Promise<boolean> => {
    dispatch({ type: "busy", id });
    try {
      const response = await apiFetch(`/api/run-artifacts/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        dispatch({ type: "failed", message: await errorMessage(response, "Could not delete artifact.") });
        return false;
      }
      rememberChange((list) => list.filter((item) => item.id !== id));
      dispatch({ type: "deleted", id });
      return true;
    } catch {
      dispatch({ type: "failed", message: "Could not delete artifact." });
      return false;
    }
  }, []);

  const download = useCallback(async (artifact: Artifact) => {
    dispatch({ type: "busy", id: artifact.id });
    try {
      const response = await apiFetch(
        `/api/run-artifacts/${encodeURIComponent(artifact.id)}/url?download=1`,
      );
      if (!response.ok) {
        dispatch({ type: "failed", message: await errorMessage(response, "Could not download artifact.") });
        return;
      }
      const payload = await response.json() as { signed_url?: string };
      if (!payload.signed_url) throw new Error("missing signed URL");
      const link = document.createElement("a");
      link.href = payload.signed_url;
      link.download = artifact.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      dispatch({ type: "busy", id: null });
    } catch {
      dispatch({ type: "failed", message: "Could not download artifact." });
    }
  }, []);

  return {
    ...state,
    reload: load,
    rename,
    remove,
    download,
    clearError: () => dispatch({ type: "clear-error" }),
  };
}
