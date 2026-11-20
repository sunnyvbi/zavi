"use client";

import { creditRefusalFrom, type CreditRefusal } from "./creditRefusal";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { buildStartBody, buildStartKey, clearBuildStartKey, keepsBuildStartKey } from "./buildStartKey";
import {
  clearOptimisticBuildStart,
  markOptimisticBuildStart,
} from "@/lib/workspace/optimisticBuildStart";

export const IDEA_MIN_CHARS = 8;
export const IDEA_MAX_CHARS = 4000;

export type BuildStatus = "none" | "building" | "live" | "failed";

export type BuildFailureDetails = {
  class: string;
  code?: string | null;
  message: string;
  stage: string | null;
  retry_count: number;
};

export type TenantResource = {
  resource_kind: string;
  status: string;
  external_ref?: Record<string, unknown> | null;
};

type AutopilotGet = {
  resources?: TenantResource[] | null;
  product_builder_enabled?: boolean | null;
  build_app_intent?: "fresh" | "existing" | null;
  company_scale_segment?: ScaleSegment | "" | null;
};

export type ScaleSegment = "pre_revenue" | "early" | "scaling" | "mature";

function readUrl(ref: Record<string, unknown> | null | undefined): string | null {
  if (!ref) return null;
  const u = ref.url;
  return typeof u === "string" && u.length > 0 ? u : null;
}

export function statusToBuildStatus(status: string, url: string | null): BuildStatus {
  if (status === "failed") return "failed";
  if (status === "ready") return url ? "live" : "building";
  if (status === "teardown" || status === "torn_down") return "none";
  return "building";
}

export function deriveApp(resources: TenantResource[] | null | undefined): {
  status: BuildStatus;
  url: string | null;
} {
  const hosting = (resources ?? []).find((r) => r.resource_kind === "hosting");
  if (!hosting) return { status: "none", url: null };
  const rawUrl = readUrl(hosting.external_ref);
  const status = statusToBuildStatus(hosting.status, rawUrl);
  return { status, url: status === "live" ? rawUrl : null };
}

const TERMINAL_FAILED_RUN = new Set(["failed", "halted", "paused", "cancelled", "canceled"]);

export function deriveBuildStatus(
  hostingStatus: string,
  url: string | null,
  runStatus: string | null,
): BuildStatus {
  if (hostingStatus === "ready" && url) return "live";
  if (hostingStatus === "teardown" || hostingStatus === "torn_down") return "none";
  if (runStatus && TERMINAL_FAILED_RUN.has(runStatus)) return "failed";
  return statusToBuildStatus(hostingStatus, url);
}

export function deriveAppStatus(
  resources: TenantResource[] | null | undefined,
  runStatus: string | null,
): { status: BuildStatus; url: string | null } {
  const hosting = (resources ?? []).find((r) => r.resource_kind === "hosting");
  if (!hosting) return { status: "none", url: null };
  const rawUrl = readUrl(hosting.external_ref);
  const status = deriveBuildStatus(hosting.status, rawUrl, runStatus);
  return { status, url: status === "live" ? rawUrl : null };
}

export type UseBuildProduct = {
  status: BuildStatus;
  url: string | null;
  failure: BuildFailureDetails | null;
  starting: boolean;
  error: string | null;
  creditRefusal: CreditRefusal | null;
  startBuild: (input: { idea?: string; company_name?: string }) => Promise<string | null>;
  runId: string | null;
  stopping: boolean;
  cancelRun: () => Promise<void>;
  runPaused: boolean;
  continueRun: () => Promise<string | null>;
  continuing: boolean;
  inflightRun: { run_id: string; status: string; created_at: string } | null;
  cancelBuild: (runId: string) => Promise<boolean>;
  canceling: boolean;
  loaded: boolean;
  enabled: boolean;
  buildAppIntent: "fresh" | "existing";
  companyScaleSegment: ScaleSegment | "";
};

const SCALE_SEGMENTS: readonly ScaleSegment[] = [
  "pre_revenue",
  "early",
  "scaling",
  "mature",
];
export function coerceScaleSegment(v: unknown): ScaleSegment | "" {
  return typeof v === "string" && (SCALE_SEGMENTS as readonly string[]).includes(v)
    ? (v as ScaleSegment)
    : "";
}

const POLL_MS = 6000;

export function useBuildProduct(): UseBuildProduct {
  const [status, setStatus] = useState<BuildStatus>("none");
  const [url, setUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<BuildFailureDetails | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [runPaused, setRunPaused] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creditRefusal, setCreditRefusal] = useState<CreditRefusal | null>(null);
  const [inflightRun, setInflightRun] = useState<
    { run_id: string; status: string; created_at: string } | null
  >(null);
  const [canceling, setCanceling] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [buildAppIntent, setBuildAppIntent] = useState<"fresh" | "existing">("existing");
  const [companyScaleSegment, setCompanyScaleSegment] = useState<ScaleSegment | "">("");

  const mounted = useRef(true);
  const statusRef = useRef<BuildStatus>(status);
  statusRef.current = status;
  const runIdRef = useRef<string | null>(runId);
  runIdRef.current = runId;
  const startedRunIdRef = useRef<string | null>(null);
  const reqCounter = useRef(0);
  const appliedSeq = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++reqCounter.current;
    try {
      const [autoRes, statusRes] = await Promise.all([
        apiFetch("/api/workspace/autopilot").catch(() => null),
        apiFetch("/api/workspace/autopilot/build-status?app=workspace").catch(() => null),
      ]);
      if (!mounted.current) return;

      if (seq <= appliedSeq.current) return;

      let runStatus: string | null = null;
      let latestRunId: string | null = null;
      let runFailure: BuildFailureDetails | null = null;
      if (statusRes && statusRes.ok) {
        const sj = (await statusRes.json()) as {
          run: { id?: string; status?: string; failure?: BuildFailureDetails | null } | null;
        };
        runStatus = sj.run?.status ?? null;
        latestRunId = sj.run?.id ?? null;
        runFailure = sj.run?.failure ?? null;
      }

      if (autoRes && autoRes.ok) {
        const data = (await autoRes.json()) as AutopilotGet;
        if (!mounted.current) return;
        if (seq <= appliedSeq.current) return;
        appliedSeq.current = seq;

        let next = deriveAppStatus(data.resources, runStatus);
        const guarding =
          next.status === "failed" &&
          !!startedRunIdRef.current &&
          latestRunId !== startedRunIdRef.current;
        if (guarding) {
          next = { status: "building", url: null };
        }
        if (latestRunId && latestRunId === startedRunIdRef.current) {
          startedRunIdRef.current = null;
        }
        setStatus(next.status);
        setUrl(next.url);
        setFailure(next.status === "failed" ? runFailure : null);
        setRunPaused(!guarding && runStatus === "paused");
        setRunId(guarding ? startedRunIdRef.current : latestRunId);
        setEnabled(Boolean(data.product_builder_enabled));
        setBuildAppIntent(data.build_app_intent === "fresh" ? "fresh" : "existing");
        setCompanyScaleSegment(coerceScaleSegment(data.company_scale_segment));
      } else if (statusRes && statusRes.ok) {
        if (seq <= appliedSeq.current) return;
        appliedSeq.current = seq;
        setRunId(latestRunId);
        setFailure(runFailure);
        setRunPaused(runStatus === "paused");
      }
    } catch {
    } finally {
      if (mounted.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();

    const tick = setInterval(() => {
      if (statusRef.current === "building") void refresh();
    }, POLL_MS);

    return () => {
      mounted.current = false;
      clearInterval(tick);
    };
  }, [refresh]);

  const startBuild = useCallback(
    async (input: { idea?: string; company_name?: string }): Promise<string | null> => {
      const priorStatus = statusRef.current;
      markOptimisticBuildStart();
      statusRef.current = "building";
      setStatus("building");
      setStarting(true);
      setError(null);
      setCreditRefusal(null);
      setFailure(null);
      setInflightRun(null);
      try {
        const body = buildStartBody({ idea: input.idea ?? "", company_name: input.company_name });
        const requestId = buildStartKey(body);
        const res = await apiFetch("/api/workspace/autopilot/build-product", {
          method: "POST",
          idempotent: true,
          headers: { "Idempotency-Key": requestId },
          body,
        });
        if (!res.ok) {
          clearOptimisticBuildStart();
          statusRef.current = priorStatus;
          if (mounted.current) setStatus(priorStatus);
          const errBody = (await res.json().catch(() => null)) as {
            error?: { code?: string; message?: string };
            run_id?: string;
            status?: string;
            created_at?: string;
          } | null;
          if (!keepsBuildStartKey(errBody?.error?.code)) clearBuildStartKey(requestId);
          const msg = errBody?.error?.message ?? `HTTP ${res.status}`;
          if (mounted.current) {
            setError(msg);
            setCreditRefusal(creditRefusalFrom(errBody, "build"));
            if (
              errBody?.error?.code === "build_already_in_progress" &&
              typeof errBody.run_id === "string" &&
              typeof errBody.status === "string" &&
              typeof errBody.created_at === "string"
            ) {
              setInflightRun({
                run_id: errBody.run_id,
                status: errBody.status,
                created_at: errBody.created_at,
              });
            }
          }
          return null;
        }
        const data = (await res.json()) as { conductor_run_id?: string };
        clearBuildStartKey(requestId);
        if (mounted.current) {
          startedRunIdRef.current = data.conductor_run_id ?? null;
          setStatus("building");
          setRunId(data.conductor_run_id ?? null);
          void refresh();
        }
        return data.conductor_run_id ?? null;
      } catch (e) {
        clearOptimisticBuildStart();
        statusRef.current = priorStatus;
        if (mounted.current) {
          setStatus(priorStatus);
          setError((e as Error).message ?? "Unknown error");
        }
        return null;
      } finally {
        if (mounted.current) setStarting(false);
      }
    },
    [refresh],
  );

  const cancelRun = useCallback(async (): Promise<void> => {
    const id = runIdRef.current;
    if (!id || stopping) return;
    setStopping(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/autopilot/runs/${id}/cancel`, {
        method: "POST",
      });
      if (!mounted.current) return;
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `HTTP ${res.status}`);
        setCreditRefusal(null);
        return;
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message ?? "Network error");
      if (mounted.current) setCreditRefusal(null);
    } finally {
      if (mounted.current) {
        setStopping(false);
        void refresh();
      }
    }
  }, [stopping, refresh]);

  const continueRun = useCallback(async (): Promise<string | null> => {
    const id = runIdRef.current;
    if (!id || continuing) return null;
    setContinuing(true);
    try {
      const res = await apiFetch(
        `/api/workspace/autopilot/runs/${encodeURIComponent(id)}/continue`,
        { method: "POST", idempotent: true },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        return body?.error?.message ?? `Couldn't continue the build (HTTP ${res.status}).`;
      }
      if (mounted.current) {
        statusRef.current = "building";
        setStatus("building");
        setRunPaused(false);
        setFailure(null);
      }
      return null;
    } catch (e) {
      return (e as Error).message || "Couldn't continue the build.";
    } finally {
      if (mounted.current) {
        setContinuing(false);
        void refresh();
      }
    }
  }, [continuing, refresh]);

  const cancelBuild = useCallback(
    async (runId: string): Promise<boolean> => {
      setCanceling(true);
      try {
        const res = await apiFetch(
          `/api/workspace/autopilot/runs/${encodeURIComponent(runId)}/cancel`,
          { method: "POST" },
        );
        const freed = res.ok || res.status === 404;
        if (freed && mounted.current) {
          setInflightRun(null);
          setError(null);
          void refresh();
        } else if (!freed && mounted.current) {
          const body = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          setError(body?.error?.message ?? `Couldn't cancel the build (HTTP ${res.status})`);
          setCreditRefusal(null);
        }
        return freed;
      } catch (e) {
        if (mounted.current) setError((e as Error).message ?? "Couldn't cancel the build");
        if (mounted.current) setCreditRefusal(null);
        return false;
      } finally {
        if (mounted.current) setCanceling(false);
      }
    },
    [refresh],
  );

  return {
    status,
    url,
    failure,
    runId,
    stopping,
    cancelRun,
    runPaused,
    continueRun,
    continuing,
    starting,
    error,
    creditRefusal,
    startBuild,
    inflightRun,
    cancelBuild,
    canceling,
    loaded,
    enabled,
    buildAppIntent,
    companyScaleSegment,
  };
}
