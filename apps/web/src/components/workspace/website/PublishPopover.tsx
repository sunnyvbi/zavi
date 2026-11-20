"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Copy,
  Check,
  ExternalLink,
  Globe,
  ChevronRight,
  EyeOff,
  Rocket,
  Loader2,
  Type,
  Palette,
  Link2,
  Image as ImageIcon,
  X,
  Plus,
  Pencil,
  MoreVertical,
  RotateCcw,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { publishReads, publishReadsKey, rememberRead, type BuiltinReply, type OverviewReply, type PublishStatus } from "./publishReads";
import { applySiteEdits } from "@/lib/workspace/siteInlineEdits";
import type { LiveEditActionResult } from "@/lib/workspace/useLiveEdit";
import { publicAppUrl } from "@/lib/workspace/publicAppUrl";
import type { BuildPublishStatus } from "@/lib/workspace/buildPublish";
import {
  SITE_ALREADY_PUBLISHED_SUB,
  SITE_ALREADY_PUBLISHED_TITLE,
  SITE_LIVE_ON_REQUEST_SUB,
  SITE_NOT_BUILT_SUB,
  SITE_NOT_PUBLISHED,
  SITE_NOT_PUBLISHED_SUB,
  SITE_PUBLISH_BUDGET,
  SITE_PUBLISH_BUILDER_OFF,
  SITE_PUBLISH_BUSY,
  SITE_PUBLISH_DAILY_LIMIT,
  SITE_PUBLISH_FAILED_SUB,
  SITE_PUBLISH_FAILED_TITLE,
  SITE_PUBLISH_FIXING_SUB,
  SITE_PUBLISH_FORBIDDEN,
  SITE_PUBLISH_NOT_FOUND,
  SITE_PUBLISH_NOTHING_YET,
  SITE_PUBLISH_PICKUP_LATE,
  SITE_PUBLISH_REFUSED,
  SITE_PUBLISH_SANDBOX_GONE,
  SITE_PUBLISH_UNREACHABLE,
  SITE_PUBLISHING_SUB,
  SITE_PUBLISHING_TITLE,
  SITE_CHANGES_PUBLISH_FAILED_SUB,
  SITE_CHANGES_READY_TITLE,
  siteChangesReadySub,
} from "@/lib/workspace/buildFraming";
import { toast } from "@/components/ui/toast";
import { Skeleton } from "../Skeleton";
import { SITE_DATABASE_WAITING } from "@zavi/shared";

export type Visibility = "public" | "private" | "unlisted";

type PendingKind = "text" | "style" | "link" | "image" | "removed" | "mixed";
type PendingChange = {
  id: string;
  updated_at: string;
  selector: string;
  kind: PendingKind;
  summary: string;
  detail: string | null;
  status: "new" | "updated";
};
const KIND_ICON: Record<PendingKind, typeof Type> = {
  text: Type,
  style: Palette,
  link: Link2,
  image: ImageIcon,
  removed: EyeOff,
  mixed: Rocket,
};

export type BuiltinUrl = {
  label: string;
  hostname: string;
  url: string;
  status: string;
  dns_ready?: boolean;
  setup_blocked?: "dns_not_configured" | null;
};

export const DNS_NOT_CONFIGURED_COPY =
  "This server can't write DNS, so the address can't go live from here. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID on the backend, or publish from the live site.";

export const BUILTIN_BLOCKED_TITLE = "Not live yet";
export const BUILTIN_NOT_LIVE_COPY = "Your site goes live here once its build finishes.";
export const BUILTIN_STUCK_TITLE = "Still setting up";

export function builtinStuckCopy(hostname: string | null | undefined): string {
  return `${hostname ?? "Your address"} is taking longer than usual. It keeps setting up in the background.`;
}

export const BUILTIN_POLL_MS = 4000;
export const BUILTIN_POLL_MAX = 45;

export function splitHost(url: string | null): { lead: string; rest: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const path = u.pathname !== "/" ? u.pathname : "";
    const dot = u.host.indexOf(".");
    if (dot <= 0) return { lead: u.host + path, rest: "" };
    return { lead: u.host.slice(0, dot), rest: u.host.slice(dot) + path };
  } catch {
    return { lead: url, rest: "" };
  }
}

async function readError(res: Response, fallback: string): Promise<string> {
  if (res.status === 403) return "Viewers can't publish. Ask a workspace owner, admin or member.";
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    return j?.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export const SITE_EDITS_APPLY_HINT = "Publishing now leaves these edits out. Apply them to write them into the site's code, then publish.";
export const SITE_EDITS_APPLYING_HINT = "Zavi is writing your edits into the site's code. Publish once that change is done to include them.";

export function siteEditsPendingLabel(count: number): string {
  return `${count} edit${count === 1 ? "" : "s"} not in the site's code yet`;
}

export function applySiteEditsLabel(count: number): string {
  return `Apply ${count} edit${count === 1 ? "" : "s"}`;
}

export function sitePublishPath(siteId: string): string {
  return `/api/workspace/autopilot/sites/${encodeURIComponent(siteId)}/publish`;
}

export type SitePublishResult =
  | { ok: true; alreadyPublished: boolean }
  | { ok: false; status: number; code: string | null; message: string };

export const SITE_ALREADY_PUBLISHED_CODE = "already_published";
export const SITE_PUBLISH_BUSY_CODE = "build_already_in_progress";

const SITE_PUBLISH_REFUSALS: ReadonlyMap<string, string> = new Map([
  ["forbidden", SITE_PUBLISH_FORBIDDEN],
  ["product_builder_disabled", SITE_PUBLISH_BUILDER_OFF],
  ["site_not_found", SITE_PUBLISH_NOT_FOUND],
  [SITE_PUBLISH_BUSY_CODE, SITE_PUBLISH_BUSY],
  ["sandbox_gone", SITE_PUBLISH_SANDBOX_GONE],
  ["site_unavailable", SITE_PUBLISH_NOTHING_YET],
  ["daily_build_limit_reached", SITE_PUBLISH_DAILY_LIMIT],
  ["provision_budget_exceeded", SITE_PUBLISH_BUDGET],
]);

export function sitePublishErrorCode(body: unknown): string | null {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
  if (typeof error === "string") return error;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
  return typeof code === "string" ? code : null;
}

export function sitePublishRefusal(code: string | null): string {
  return (code ? SITE_PUBLISH_REFUSALS.get(code) : undefined) ?? SITE_PUBLISH_REFUSED;
}

export async function requestSitePublish(siteId: string): Promise<SitePublishResult> {
  try {
    const res = await apiFetch(sitePublishPath(siteId), {
      method: "POST",
      idempotent: true,
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (res.ok) return { ok: true, alreadyPublished: false };
    const code = sitePublishErrorCode(await res.json().catch(() => null));
    if (code === SITE_ALREADY_PUBLISHED_CODE) return { ok: true, alreadyPublished: true };
    return { ok: false, status: res.status, code, message: sitePublishRefusal(code) };
  } catch {
    return { ok: false, status: 0, code: null, message: SITE_PUBLISH_UNREACHABLE };
  }
}

export type SitePublishOnRequest = {
  siteId: string;
  hostname: string | null;
  built: boolean;
  status: BuildPublishStatus;
  reason?: string | null;
  fixing?: boolean;
  waiting?: boolean;
  late?: boolean;
  onStarted?: () => void;
  onRefresh?: () => void;
  changes?: { count: number; items: Array<{ id: string; kind: "edit" | "undo"; message: string | null }> } | null;
  onUndoChange?: (id: string) => Promise<{ error: string | null; notice: string | null }>;
};

export const COMPARE_WITH_LIVE = "Compare with live site";

export function waitingChangeLabel(c: { kind: "edit" | "undo"; message: string | null }): string {
  if (c.kind === "undo") return c.message ?? "Undid a change";
  return c.message ?? "A change from the chat";
}

const SITE_SERVING = new Set(["live", "publishing", "paused", "waking"]);

export function PublishPopover({
  appUrl,
  appHost,
  publishable,
  onGetDomain,
  onDiscarded,
  onPublished,
  onClose,
  onBusyChange,
  draft,
  site = null,
  ownBuildApp = false,
  sitePublish = null,
  siteEditsApp = null,
  siteEditsApplying = false,
  onSiteEditsApplied,
}: {
  appUrl: string | null;
  appHost: string | null;
  publishable: boolean;
  site?: { liveUrl: string | null; status: string } | null;
  onGetDomain: () => void;
  onDiscarded?: () => void;
  onPublished?: () => void;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
  draft?: {
    pending: number;
    changes: Array<{ sha: string; message: string }>;
    publish: () => Promise<LiveEditActionResult>;
    discard: () => Promise<LiveEditActionResult>;
    onPublished: (commitSha: string, count: number) => void;
  };
  ownBuildApp?: boolean;
  sitePublish?: SitePublishOnRequest | null;
  siteEditsApp?: string | null;
  siteEditsApplying?: boolean;
  onSiteEditsApplied?: (result: { applied: number; remaining: number; conductorRunId: string | null; direct?: boolean }) => void;
}) {
  const siteSession = site !== null;
  const editsApp = site !== null ? siteEditsApp : appHost;
  const editsReadable = site !== null ? !!siteEditsApp : publishable;
  const readsBuiltin = !siteSession && !(!publishable && appUrl && !ownBuildApp);
  const readsKey = publishReadsKey(editsApp, siteSession);
  const seeded = publishReads.get(readsKey);
  const [visibility, setVisibility] = useState<Visibility | null>(() => seeded?.overview?.visibility ?? null);
  const [savingVis, setSavingVis] = useState(false);
  const [copied, setCopied] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);

  const [pubStatus, setPubStatus] = useState<PublishStatus | null>(() => seeded?.status ?? null);
  const [confirming, setConfirming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [justPublished, setJustPublished] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const [builtin, setBuiltin] = useState<BuiltinUrl | null>(() => seeded?.builtin?.builtin ?? null);
  const [baseDomain, setBaseDomain] = useState(() => seeded?.builtin?.base_domain ?? "zaviagent.com");
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlLocked, setUrlLocked] = useState(() => seeded?.builtin?.custom_domain_attached === true);
  const [labelDraft, setLabelDraft] = useState("");
  const [savingLabel, setSavingLabel] = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);
  const pollCount = useRef(0);
  const lastStatus = useRef<string | null>(null);

  const [reviewOpen, setReviewOpen] = useState(false);
  const [changes, setChanges] = useState<PendingChange[] | null>(null);
  const [loadingChanges, setLoadingChanges] = useState(false);
  const [discarding, setDiscarding] = useState<string | null>(null);

  const [initializing, setInitializing] = useState(
    () => !((!editsReadable || !editsApp || !!seeded?.status) && (siteSession || !!seeded?.overview) && (!readsBuiltin || !!seeded?.builtin)),
  );

  const refreshStatus = useCallback(async () => {
    if (!editsReadable || !editsApp) return;
    try {
      const res = await apiFetch(`/api/website/publish-status?app=${encodeURIComponent(editsApp)}`);
      if (!res.ok) return;
      const j = (await res.json()) as PublishStatus;
      rememberRead(readsKey, "status", j);
      setPubStatus(j);
    } catch {
      return;
    }
  }, [editsReadable, editsApp, readsKey]);

  const refreshBuiltin = useCallback(async () => {
    if (!readsBuiltin) return;
    try {
      const res = await apiFetch("/api/website/builtin-url");
      if (!res.ok) return;
      const j = (await res.json()) as BuiltinReply;
      rememberRead(readsKey, "builtin", j);
      setBuiltin(j.builtin ?? null);
      setUrlLocked(j.custom_domain_attached === true);
      if (j.base_domain) setBaseDomain(j.base_domain);
    } catch {
      return;
    }
  }, [readsBuiltin, readsKey]);

  const refreshChanges = useCallback(async () => {
    if (!editsReadable || !editsApp) return;
    setLoadingChanges(true);
    try {
      const res = await apiFetch(`/api/website/pending?app=${encodeURIComponent(editsApp)}`);
      if (!res.ok) return;
      const j = (await res.json()) as { items: PendingChange[] };
      setChanges(j.items ?? []);
    } catch {
      return;
    } finally {
      setLoadingChanges(false);
    }
  }, [editsReadable, editsApp]);

  const refreshVisibility = useCallback(async () => {
    if (siteSession) return;
    try {
      const res = await apiFetch("/api/website/overview?app=workspace");
      if (!res.ok) return;
      const j = (await res.json()) as OverviewReply;
      rememberRead(readsKey, "overview", j);
      if (j.visibility) setVisibility(j.visibility);
    } catch {
      return;
    }
  }, [siteSession, readsKey]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.allSettled([refreshStatus(), refreshVisibility(), refreshBuiltin()]);
      if (!cancelled) setInitializing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshStatus, refreshVisibility, refreshBuiltin]);

  const verifying = builtin?.status === "verifying";
  const dnsBlocked = verifying && builtin?.setup_blocked === "dns_not_configured";
  const settingUp = verifying && !dnsBlocked;
  const [pollRound, setPollRound] = useState(0);
  const [pollExhausted, setPollExhausted] = useState(false);
  useEffect(() => {
    if (!settingUp) {
      setPollExhausted(false);
      return;
    }
    pollCount.current = 0;
    setPollExhausted(false);
    const t = window.setInterval(() => {
      pollCount.current += 1;
      void refreshBuiltin();
      if (pollCount.current >= BUILTIN_POLL_MAX) {
        window.clearInterval(t);
        setPollExhausted(true);
      }
    }, BUILTIN_POLL_MS);
    return () => window.clearInterval(t);
  }, [settingUp, pollRound, refreshBuiltin]);
  const checkAgain = useCallback(() => {
    setPollRound((n) => n + 1);
    void refreshBuiltin();
  }, [refreshBuiltin]);

  useEffect(() => {
    const status = builtin?.status ?? null;
    if (status === "live" && lastStatus.current === "verifying") onPublished?.();
    lastStatus.current = status;
  }, [builtin?.status, onPublished]);

  const discard = useCallback(
    async (change: PendingChange | null) => {
      if (!editsApp) return;
      const selector = change?.selector ?? null;
      setDiscarding(selector ?? "__all__");
      try {
        const res = await apiFetch("/api/website/discard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            change
              ? { app_id: editsApp, selector: change.selector, expected: { id: change.id, updated_at: change.updated_at } }
              : { app_id: editsApp },
          ),
        });
        if (!res.ok) {
          const message = await readError(res, "We couldn't update visibility.");
          if (res.status === 409) {
            setPublishError(message);
            await Promise.all([refreshStatus(), refreshChanges()]);
            return;
          }
          throw new Error(message);
        }
        setPublishError(null);
        await Promise.all([refreshStatus(), refreshChanges()]);
        onDiscarded?.();
      } catch {
        return;
      } finally {
        setDiscarding(null);
      }
    },
    [editsApp, refreshStatus, refreshChanges, onDiscarded],
  );

  const toggleReview = useCallback(() => {
    setReviewOpen((open) => {
      const next = !open;
      if (next && changes === null) void refreshChanges();
      return next;
    });
  }, [changes, refreshChanges]);

  const editsPending = pubStatus?.pending ?? 0;
  const pending = siteSession ? 0 : editsPending;
  const published = pubStatus?.published ?? 0;
  const draftPending = draft?.pending ?? 0;
  const totalPending = pending + draftPending;
  const [draftOpen, setDraftOpen] = useState(false);
  const [discardingDraft, setDiscardingDraft] = useState(false);

  const onRequest = site !== null ? sitePublish : null;
  const [undoingChange, setUndoingChange] = useState<string | null>(null);
  const [undoLine, setUndoLine] = useState<{ text: string; error: boolean } | null>(null);
  const undoWaitingChange = useCallback(
    async (id: string) => {
      const undo = onRequest?.onUndoChange;
      if (!undo || undoingChange) return;
      setUndoingChange(id);
      setUndoLine(null);
      try {
        const out = await undo(id);
        if (out.error) setUndoLine({ text: out.error, error: true });
        else {
          setUndoLine(out.notice ? { text: out.notice, error: false } : null);
          onRequest?.onRefresh?.();
        }
      } catch {
        setUndoLine({ text: "Couldn't undo this change. Try again.", error: true });
      } finally {
        setUndoingChange(null);
      }
    },
    [onRequest, undoingChange],
  );
  const [requesting, setRequesting] = useState(false);
  const [started, setStarted] = useState(false);
  const [alreadyPublished, setAlreadyPublished] = useState(false);
  const requestingRef = useRef(false);
  const onRequestStatus = onRequest?.status ?? null;
  const onRequestLate = onRequest?.late === true;
  const publishIdentity = onRequest?.siteId ?? appHost ?? "workspace";
  const requestScope = useRef({ identity: publishIdentity, generation: 0, mounted: true });
  if (requestScope.current.identity !== publishIdentity) {
    requestScope.current = { identity: publishIdentity, generation: requestScope.current.generation + 1, mounted: true };
  }
  useEffect(() => {
    requestScope.current.mounted = true;
    return () => { requestScope.current.mounted = false; requestScope.current.generation += 1; };
  }, []);
  useEffect(() => {
    requestingRef.current = false;
    setRequesting(false);
    setStarted(false);
    setAlreadyPublished(false);
    setPublishError(null);
    setJustPublished(false);
  }, [publishIdentity]);
  useEffect(() => {
    if (onRequestStatus !== "none" || onRequestLate) setStarted(false);
    setAlreadyPublished(false);
  }, [onRequestStatus, onRequestLate]);
  useEffect(() => {
    if (!started || !onRequest) return;
    const timer = window.setTimeout(() => {
      setStarted(false);
      onRequest.onRefresh?.();
    }, 65_000);
    return () => window.clearTimeout(timer);
  }, [started, onRequest?.siteId, onRequest?.onRefresh]);
  const doSitePublish = async () => {
    if (!onRequest || requestingRef.current) return;
    const generation = requestScope.current.generation;
    const current = () => requestScope.current.mounted && requestScope.current.generation === generation;
    requestingRef.current = true;
    setRequesting(true);
    setPublishError(null);
    try {
      const result = await requestSitePublish(onRequest.siteId);
      if (!current()) return;
      if (result.ok && result.alreadyPublished) {
        setAlreadyPublished(true);
        onRequest.onRefresh?.();
      } else if (result.ok) {
        setStarted(true);
        onRequest.onStarted?.();
      } else {
        setPublishError(result.message);
        if (result.status === 0 || result.code === SITE_PUBLISH_BUSY_CODE) onRequest.onRefresh?.();
      }
    } finally {
      if (current()) {
        requestingRef.current = false;
        setRequesting(false);
      }
    }
  };
  const sitePublishing = !!onRequest && (requesting || started || onRequest.status === "publishing");
  const sitePublishFailed = !!onRequest && !sitePublishing && onRequest.status === "failed";
  const sitePublishLive = !!onRequest && !sitePublishing && onRequest.status === "live";

  const [applyingEdits, setApplyingEdits] = useState(false);
  const siteEditsPending = siteSession && !!siteEditsApp ? editsPending : 0;
  const siteEditsBusy = applyingEdits || siteEditsApplying;
  const doApplySiteEdits = async () => {
    if (!siteEditsApp || siteEditsBusy) return;
    setApplyingEdits(true);
    setPublishError(null);
    try {
      const result = await applySiteEdits(siteEditsApp);
      if (!result.ok) {
        setPublishError(result.message);
        return;
      }
      await Promise.all([refreshStatus(), reviewOpen ? refreshChanges() : Promise.resolve()]);
      onSiteEditsApplied?.({ applied: result.applied, remaining: result.remaining, conductorRunId: result.conductorRunId, ...(result.direct ? { direct: true } : {}) });
    } finally {
      setApplyingEdits(false);
    }
  };

  const wasApplyingRef = useRef(siteEditsApplying);
  useEffect(() => {
    if (wasApplyingRef.current && !siteEditsApplying) {
      void refreshStatus();
      if (reviewOpen) void refreshChanges();
    }
    wasApplyingRef.current = siteEditsApplying;
  }, [siteEditsApplying, refreshStatus, refreshChanges, reviewOpen]);

  const busy = publishing || discardingDraft || requesting || applyingEdits;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  const discardDraft = useCallback(async () => {
    if (!draft) return;
    setDiscardingDraft(true);
    setPublishError(null);
    try {
      const r = await draft.discard();
      if (!r.ok) setPublishError(r.message);
      else onDiscarded?.();
    } finally {
      setDiscardingDraft(false);
    }
  }, [draft, onDiscarded]);

  const doPublish = useCallback(async () => {
    if (!appHost) return;
    setPublishing(true);
    setConfirming(false);
    setPublishError(null);
    try {
      let address = builtin;
      if (!siteSession && (!address || address.status !== "live")) {
        const res = await apiFetch("/api/website/builtin-url/ensure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (!res.ok) {
          setPublishError(await readError(res, "We couldn't publish your app. Try again."));
          return;
        }
        const j = (await res.json()) as { builtin?: BuiltinUrl | null; base_domain?: string };
        address = j.builtin ?? null;
        setBuiltin(address);
        if (j.base_domain) setBaseDomain(j.base_domain);
        setPollRound((n) => n + 1);
        onPublished?.();
        if (address && address.status !== "live" && address.setup_blocked === "dns_not_configured") {
          toast.add({
            type: "warning",
            title: "Still can't go live here",
            description: "This server has no DNS access, so the address stays parked. Publishing works on the live site.",
          });
          if (totalPending === 0) return;
        }
      }
      if (draft && draftPending > 0) {
        const r = await draft.publish();
        if (!r.ok) {
          setPublishError(r.message);
          return;
        }
        if (r.commit_sha) draft.onPublished(r.commit_sha, draftPending);
      }
      if (pending > 0) {
        const res = await apiFetch("/api/website/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ app_id: appHost }),
        });
        if (!res.ok) {
          setPublishError(await readError(res, "Your address is live, but the latest edits didn't publish. Try again."));
          return;
        }
        await refreshStatus();
      }
      setJustPublished(true);
      window.setTimeout(() => setJustPublished(false), 2600);
    } catch {
      setPublishError("We couldn't reach the server. Try again.");
    } finally {
      setPublishing(false);
    }
  }, [appHost, builtin, pending, draft, draftPending, totalPending, refreshStatus, onPublished, siteSession]);

  const doRevert = useCallback(async () => {
    if (!appHost) return;
    setReverting(true);
    try {
      const res = await apiFetch("/api/website/unpublish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appHost }),
      });
      if (!res.ok) throw new Error(String(res.status));
      await refreshStatus();
    } catch {
      return;
    } finally {
      setReverting(false);
    }
  }, [appHost, refreshStatus]);

  const openLabelEditor = useCallback(() => {
    setLabelDraft(builtin?.label ?? "");
    setLabelError(null);
    setEditingUrl(true);
  }, [builtin?.label]);

  const saveLabel = useCallback(async () => {
    const label = labelDraft.trim().toLowerCase();
    if (!label) {
      setLabelError("Enter a name.");
      return;
    }
    if (label === builtin?.label) {
      setEditingUrl(false);
      return;
    }
    setSavingLabel(true);
    setLabelError(null);
    try {
      const res = await apiFetch("/api/website/builtin-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) {
        setLabelError(await readError(res, "We couldn't change that address."));
        return;
      }
      const j = (await res.json()) as { builtin?: BuiltinUrl | null };
      setBuiltin(j.builtin ?? null);
      setEditingUrl(false);
      onPublished?.();
    } catch {
      setLabelError("We couldn't reach the server. Try again.");
    } finally {
      setSavingLabel(false);
    }
  }, [labelDraft, builtin?.label, onPublished]);

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (moreRef.current && !moreRef.current.contains(target)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [moreOpen]);

  const resetToPublic = useCallback(
    async () => {
      const next: Visibility = "public";
      const prev = visibility;
      if (next === prev) return;
      setVisibility(next);
      setSavingVis(true);
      try {
        const res = await apiFetch("/api/website/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ visibility: next }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as { visibility: Visibility };
        setVisibility(j.visibility);
      } catch (error) {
        setVisibility(prev ?? null);
        toast.add({
          type: "error",
          title: error instanceof Error ? error.message : "We couldn't update visibility.",
        });
      } finally {
        setSavingVis(false);
      }
    },
    [visibility],
  );

  const offline = builtin?.status === "offline";
  const siteLiveUrl = site && SITE_SERVING.has(site.status) ? site.liveUrl : null;
  const notLive = !siteSession && (builtin?.status === "not_live" || (ownBuildApp && !publishable));
  const liveUrl = siteSession
    ? siteLiveUrl
    : offline || notLive
    ? null
    : publishable
    ? builtin?.status === "live"
      ? builtin.url
      : publicAppUrl(appUrl)
    : appUrl ?? (builtin?.status === "live" ? builtin.url : null);
  const plannedUrl = onRequest?.hostname ? `https://${onRequest.hostname}` : null;
  const shownUrl = liveUrl ?? (siteSession ? site?.liveUrl ?? plannedUrl : builtin ? builtin.url : null);
  const host = splitHost(shownUrl);

  const copyUrl = useCallback(async () => {
    if (!liveUrl) return;
    try {
      await navigator.clipboard.writeText(liveUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      return;
    }
  }, [liveUrl]);

  const storedNotEnforced = !siteSession && visibility !== null && visibility !== "public";
  const hasApp = !!appUrl;
  const unpublished = !siteSession && publishable && hasApp && !builtin && !liveUrl;

  const pendingChanges = onRequest?.changes && onRequest.changes.count > 0 ? onRequest.changes : null;
  const status = pendingChanges
    ? sitePublishing
      ? { dot: "bg-[#e8a317]", title: SITE_PUBLISHING_TITLE, sub: onRequest?.waiting ? onRequest.reason || SITE_DATABASE_WAITING : SITE_PUBLISHING_SUB }
      : sitePublishFailed
        ? { dot: "bg-[#d92d20]", title: SITE_PUBLISH_FAILED_TITLE, sub: onRequest?.reason || SITE_CHANGES_PUBLISH_FAILED_SUB }
        : alreadyPublished
          ? { dot: "bg-[#22a06b]", title: SITE_ALREADY_PUBLISHED_TITLE, sub: SITE_ALREADY_PUBLISHED_SUB }
          : { dot: "bg-[#e8a317]", title: SITE_CHANGES_READY_TITLE, sub: siteChangesReadySub(pendingChanges.count) }
    : onRequest
    ? alreadyPublished
      ? { dot: "bg-[#22a06b]", title: SITE_ALREADY_PUBLISHED_TITLE, sub: SITE_ALREADY_PUBLISHED_SUB }
      : sitePublishing
      ? {
          dot: "bg-[#e8a317]",
          title: SITE_PUBLISHING_TITLE,
          sub: onRequest.fixing
            ? [SITE_PUBLISH_FIXING_SUB, onRequest.reason].filter(Boolean).join(" ")
            : onRequest.waiting
              ? onRequest.reason || SITE_DATABASE_WAITING
              : SITE_PUBLISHING_SUB,
        }
      : sitePublishFailed
        ? { dot: "bg-[#d92d20]", title: SITE_PUBLISH_FAILED_TITLE, sub: onRequest.reason || SITE_PUBLISH_FAILED_SUB }
        : sitePublishLive
        ? { dot: "bg-[#22a06b]", title: SITE_ALREADY_PUBLISHED_TITLE, sub: SITE_LIVE_ON_REQUEST_SUB }
        : {
            dot: "bg-[#b5b5b5]",
            title: SITE_NOT_PUBLISHED,
            sub: !onRequest.built ? SITE_NOT_BUILT_SUB : onRequest.late ? SITE_PUBLISH_PICKUP_LATE : SITE_NOT_PUBLISHED_SUB,
          }
    : siteSession && !liveUrl
    ? site?.status === "failed"
      ? { dot: "bg-[#d92d20]", title: "Not live", sub: "This site's last build didn't go live" }
      : { dot: "bg-[#e8a317]", title: "Not live yet", sub: "Your site goes live when its build finishes" }
    : !hasApp && liveUrl
    ? { dot: "bg-[#22a06b]", title: "Live", sub: "Live on the web" }
    : !hasApp && dnsBlocked && builtin
    ? { dot: "bg-[#e8a317]", title: BUILTIN_BLOCKED_TITLE, sub: DNS_NOT_CONFIGURED_COPY }
    : !hasApp && settingUp && builtin
    ? pollExhausted
      ? { dot: "bg-[#e8a317]", title: BUILTIN_STUCK_TITLE, sub: builtinStuckCopy(builtin.hostname) }
      : { dot: "bg-[#e8a317]", title: "Setting up your address", sub: builtin.hostname }
    : notLive
    ? { dot: "bg-[#e8a317]", title: BUILTIN_BLOCKED_TITLE, sub: BUILTIN_NOT_LIVE_COPY }
    : !hasApp && !offline
    ? { dot: "bg-[#b5b5b5]", title: "Not published", sub: "Build your app to get a live link" }
    : offline
      ? { dot: "bg-[#d92d20]", title: "Offline", sub: "Your site's hosting is suspended, so visitors see an error page" }
    : !publishable
      ? {
          dot: "bg-[#22a06b]",
          title: "Live",
          sub: "Live on the web. Inline edits publish only on apps Zavi built.",
        }
      : unpublished
        ? { dot: "bg-[#b5b5b5]", title: "Not published", sub: `Publish to put it live at a ${baseDomain} address` }
        : dnsBlocked && !liveUrl
          ? { dot: "bg-[#e8a317]", title: BUILTIN_BLOCKED_TITLE, sub: DNS_NOT_CONFIGURED_COPY }
        : settingUp && !liveUrl
          ? {
              dot: "bg-[#e8a317]",
              title: pollExhausted ? BUILTIN_STUCK_TITLE : "Publishing…",
              sub: pollExhausted
                ? builtinStuckCopy(builtin?.hostname)
                : builtin?.dns_ready === false
                  ? `Setting up DNS for ${builtin?.hostname ?? "your address"}`
                  : `Setting up ${builtin?.hostname ?? "your address"}`,
            }
          : totalPending > 0
            ? {
                dot: "bg-[#e8a317]",
                title: "Live",
                sub: `${totalPending} unpublished change${totalPending === 1 ? "" : "s"}`,
              }
            : pubStatus && !siteSession
              ? { dot: "bg-[#22a06b]", title: "Live", sub: "Your website is up to date" }
              : { dot: "bg-[#22a06b]", title: "Live", sub: "Live on the web" };

  const notLiveYet = publishable && hasApp && !!builtin && !liveUrl && !offline;
  const canPublish = hasApp && publishable && !publishing && !notLive && (unpublished || notLiveYet || totalPending > 0);
  const publishLabel = publishing
    ? "Publishing…"
    : justPublished
      ? "Live"
      : unpublished || notLiveYet || (!hasApp && !liveUrl)
        ? "Publish"
        : totalPending === 0 && !!liveUrl && !offline
          ? "Up to date"
          : "Publish changes";

  return (
    <div
      role="dialog"
      aria-label="Publish your app"
      className="absolute right-0 top-full z-30 mt-2 w-[380px] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl border border-[#ececec] bg-white p-4 shadow-[0_16px_48px_-12px_rgba(14,15,17,0.28)]"
    >
      {initializing ? (
        <div role="status" aria-busy="true" aria-label="Loading publish options">
          <Skeleton className="h-6 w-40" rounded="rounded" />
          <Skeleton className="mt-2 h-4 w-52 max-w-full" rounded="rounded" delayMs={80} />
          <Skeleton className="mt-6 h-4 w-28" rounded="rounded" delayMs={160} />
          <Skeleton className="mt-3 h-[106px] w-full" rounded="rounded-xl" delayMs={240} />
          <Skeleton className="mt-5 ml-auto h-10 w-36" rounded="rounded-full" delayMs={320} />
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${status.dot}`} />
                <h3 className="text-[20px] font-semibold leading-tight text-[#0e0f11]">{status.title}</h3>
              </div>
              <p className="mt-1.5 text-[14px] text-[#8c8c8c]">{status.sub}</p>
            </div>
            {liveUrl && (
              <div ref={moreRef} className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setMoreOpen((v) => !v)}
                  aria-label="More options"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  className="grid h-8 w-8 place-items-center rounded-cta text-[#454545] transition-colors hover:bg-[#f4f4f4]"
                >
                  <MoreVertical className="h-4 w-4" />
                </button>
                {moreOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-lg border border-[#ececec] bg-white py-1 shadow-lg"
                  >
                    <a
                      role="menuitem"
                      href={liveUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={onClose}
                      className="flex items-center gap-2 px-3 py-2 text-[13px] text-[#0e0f11] hover:bg-[#f9f9f9]"
                    >
                      <ExternalLink className="h-4 w-4 text-[#595959]" /> Open app
                    </a>
                    {publishable && published > 0 && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMoreOpen(false);
                          void doRevert();
                        }}
                        disabled={reverting}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-[#0e0f11] hover:bg-[#f9f9f9] disabled:opacity-60"
                      >
                        {reverting ? (
                          <Loader2 className="h-4 w-4 animate-spin text-[#595959]" />
                        ) : (
                          <RotateCcw className="h-4 w-4 text-[#595959]" />
                        )}
                        Revert inline edits
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="mt-6 flex items-center justify-between gap-3">
            <span className="text-[14px] font-medium text-[#0e0f11]">Website URL</span>
            {!siteSession && (
            <button
              type="button"
              onClick={onGetDomain}
              className="inline-flex items-center gap-1 text-[14px] font-medium text-[#2563eb] transition-colors hover:text-[#1d4ed8]"
            >
              <Plus className="h-4 w-4" /> Add domain
            </button>
            )}
          </div>

          <div className="mt-3 overflow-hidden rounded-xl border border-[#ececec]">
            {editingUrl ? (
              <div className="px-4 py-3">
                <div className="flex items-center rounded-lg border border-[#d4d4d4] focus-within:border-[#0e0f11]">
                  <input
                    value={labelDraft}
                    autoFocus
                    disabled={savingLabel}
                    aria-label="Website address name"
                    onChange={(e) => setLabelDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveLabel();
                      if (e.key === "Escape") setEditingUrl(false);
                    }}
                    placeholder="your-app"
                    className="h-9 min-w-0 flex-1 rounded-l-lg bg-transparent px-3 text-[13px] text-[#0e0f11] outline-none disabled:opacity-60"
                  />
                  <span className="shrink-0 select-none pr-3 text-[13px] text-[#8c8c8c]">.{baseDomain}</span>
                </div>
                {labelError ? (
                  <p role="alert" className="mt-2 text-[12px] text-[#c0392b]">{labelError}</p>
                ) : (
                  <p className="mt-2 text-[12px] text-[#8c8c8c]">Lowercase letters, numbers and hyphens.</p>
                )}
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingUrl(false)}
                    disabled={savingLabel}
                    className="inline-flex h-8 items-center rounded-full border border-[#ececec] bg-white px-3 text-[13px] font-semibold text-[#454545] transition-colors hover:bg-[#f9f9f9] disabled:opacity-60"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveLabel()}
                    disabled={savingLabel}
                    className="inline-flex h-8 items-center gap-2 rounded-full bg-[#0e0f11] px-3.5 text-[13px] font-semibold text-white transition-colors hover:bg-[#0e0f11]/85 disabled:opacity-60"
                  >
                    {savingLabel && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Save address
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex min-h-[52px] items-center gap-3 px-4 py-3">
                <img src="/zavi-icon.svg" alt="" className="h-5 w-5 shrink-0" />
                {host ? (
                  <span className="min-w-0 flex-1 truncate text-[14px]" title={shownUrl ?? undefined}>
                    <span className="font-medium text-[#0e0f11]">{host.lead}</span>
                    <span className="text-[#8c8c8c]">{host.rest}</span>
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-[14px] text-[#8c8c8c]">
                    {hasApp && publishable ? "No public link yet" : "No live link yet"}
                  </span>
                )}
                {settingUp && !liveUrl && (
                  <span className="shrink-0 rounded-md bg-[#fff4e5] px-2 py-0.5 text-[11px] font-semibold text-[#b45309]">
                    Setting up…
                  </span>
                )}
                {hasApp && publishable && !siteSession && (
                  <button
                    type="button"
                    onClick={openLabelEditor}
                    disabled={urlLocked && !!builtin}
                    title={
                      urlLocked && builtin
                        ? "Remove your custom domain first to change your Zavi address"
                        : "Change your address"
                    }
                    aria-label="Edit URL"
                    className="shrink-0 rounded p-1 text-[#8c8c8c] transition-colors hover:bg-[#f4f4f4] hover:text-[#0e0f11] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                )}
                {liveUrl && (
                  <button
                    type="button"
                    onClick={() => void copyUrl()}
                    title="Copy link"
                    aria-label="Copy link"
                    className="shrink-0 rounded p-1 text-[#8c8c8c] transition-colors hover:bg-[#f4f4f4] hover:text-[#0e0f11]"
                  >
                    {copied ? <Check className="h-4 w-4 text-[#22a06b]" /> : <Copy className="h-4 w-4" />}
                  </button>
                )}
              </div>
            )}
            {!editingUrl && urlLocked && builtin && (
              <p className="px-4 pb-3 text-[12px] text-[#8c8c8c]">
                Remove your custom domain first to change your Zavi address.
              </p>
            )}

            <div className="h-px bg-[#f0f0f0]" />

            <div className="flex min-h-[52px] w-full items-center gap-3 px-4 py-3">
              <Globe className="h-5 w-5 shrink-0 text-[#595959]" />
              <span className="min-w-0 flex-1 text-[14px] text-[#0e0f11]">Visible to anyone with the link</span>
              {savingVis && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#8c8c8c]" />}
            </div>

            {storedNotEnforced && (
              <div className="border-t border-[#f0f0f0] bg-[#fafafa] px-4 py-3">
                <p className="text-[12px] leading-5 text-[#a15c07]">
                  Your app was set to {visibility}, but access control isn’t live yet, so anyone with the link can
                  still open it.
                </p>
                <button
                  type="button"
                  onClick={() => void resetToPublic()}
                  disabled={savingVis}
                  className="mt-2 inline-flex h-8 items-center rounded-cta border border-[#ececec] bg-white px-3 text-[13px] font-medium text-[#0e0f11] transition-colors hover:bg-[#f4f4f4] disabled:opacity-60"
                >
                  Set to Public
                </button>
              </div>
            )}
          </div>

          {hasApp && publishable && draft && draftPending > 0 && !confirming && (
            <div data-testid="draft-changes" className="mt-4 overflow-hidden rounded-xl border border-[#ececec]">
              <button
                type="button"
                onClick={() => setDraftOpen((v) => !v)}
                aria-expanded={draftOpen}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-[#f9f9f9]"
              >
                <ChevronRight
                  className={`h-4 w-4 shrink-0 text-[#8c8c8c] transition-transform ${draftOpen ? "rotate-90" : ""}`}
                />
                <span className="flex-1 text-[13px] font-semibold text-[#0e0f11]">
                  {draftPending} change{draftPending === 1 ? "" : "s"} in preview
                </span>
                <span className="text-[12px] text-[#8c8c8c]">{draftOpen ? "Hide" : "Review"}</span>
              </button>
              {draftOpen && (
                <div className="border-t border-[#f0f0f0]">
                  <ul className="max-h-[188px] overflow-y-auto">
                    {draft.changes.map((c) => (
                      <li
                        key={c.sha}
                        className="border-b border-[#f5f5f5] px-4 py-2.5 text-[13px] font-semibold text-[#0e0f11] last:border-b-0"
                      >
                        {c.message || "Change"}
                      </li>
                    ))}
                  </ul>
                  <div className="border-t border-[#f0f0f0] px-4 py-2">
                    <button
                      type="button"
                      onClick={() => void discardDraft()}
                      disabled={discardingDraft}
                      className="inline-flex items-center gap-2 text-[12px] font-semibold text-[#8c8c8c] underline transition-colors hover:text-[#c0392b] disabled:opacity-50"
                    >
                      {discardingDraft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                      Discard preview changes
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {(siteSession ? siteEditsPending > 0 : hasApp && publishable && pending > 0) && !confirming && (
            <div className="mt-4 overflow-hidden rounded-xl border border-[#ececec]">
              <button
                type="button"
                onClick={toggleReview}
                aria-expanded={reviewOpen}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-[#f9f9f9]"
              >
                <ChevronRight
                  className={`h-4 w-4 shrink-0 text-[#8c8c8c] transition-transform ${reviewOpen ? "rotate-90" : ""}`}
                />
                <span className="flex-1 text-[13px] font-semibold text-[#0e0f11]">
                  {siteSession
                    ? siteEditsPendingLabel(siteEditsPending)
                    : `${pending} unpublished change${pending === 1 ? "" : "s"}`}
                </span>
                <span className="text-[12px] text-[#8c8c8c]">{reviewOpen ? "Hide" : "Review"}</span>
              </button>

              {reviewOpen && (
                <div className="border-t border-[#f0f0f0]">
                  {loadingChanges && changes === null ? (
                    <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-[#8c8c8c]">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading changes…
                    </div>
                  ) : changes && changes.length > 0 ? (
                    <>
                      <ul className="max-h-[188px] overflow-y-auto">
                        {changes.map((c) => {
                          const Icon = KIND_ICON[c.kind];
                          const busy = discarding === c.selector;
                          return (
                            <li
                              key={c.selector}
                              className="flex items-start gap-2.5 border-b border-[#f5f5f5] px-4 py-2.5 last:border-b-0"
                            >
                              <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[#f4f4f4] text-[#595959]">
                                <Icon className="h-3.5 w-3.5" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-2">
                                  <span className="text-[13px] font-semibold text-[#0e0f11]">{c.summary}</span>
                                  {c.status === "new" && (
                                    <span className="rounded bg-[#f0f0f0] px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide text-[#8c8c8c]">
                                      New
                                    </span>
                                  )}
                                </span>
                                {c.detail ? (
                                  <span className="mt-0.5 block truncate text-[12px] text-[#8c8c8c]" title={c.detail}>
                                    {c.detail}
                                  </span>
                                ) : (
                                  <span className="mt-0.5 block truncate text-[12px] text-[#b0b0b0]" title={c.selector}>
                                    {c.selector}
                                  </span>
                                )}
                              </span>
                              <button
                                type="button"
                                onClick={() => void discard(c)}
                                disabled={!!discarding}
                                title="Discard this change"
                                aria-label={`Discard change: ${c.summary}`}
                                className="mt-0.5 shrink-0 rounded p-1 text-[#b0b0b0] transition-colors hover:bg-[#f4f4f4] hover:text-[#c0392b] disabled:opacity-50"
                              >
                                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                      <div className="border-t border-[#f0f0f0] px-4 py-2">
                        <button
                          type="button"
                          onClick={() => void discard(null)}
                          disabled={!!discarding}
                          className="inline-flex items-center gap-2 text-[12px] font-semibold text-[#8c8c8c] transition-colors hover:text-[#c0392b] disabled:opacity-50"
                        >
                          {discarding === "__all__" ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <X className="h-3.5 w-3.5" />
                          )}
                          Discard all changes
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="px-4 py-3 text-[12px] text-[#8c8c8c]">No unpublished changes.</div>
                  )}
                </div>
              )}
            </div>
          )}

          {publishError && (
            <div
              role="alert"
              className="mt-4 flex items-start gap-2.5 rounded-xl bg-[#fdf2f2] px-3.5 py-3 text-[13px] leading-5 text-[#8a1c1c]"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#c0392b]" aria-hidden />
              <span className="min-w-0 flex-1">{publishError}</span>
              <button
                type="button"
                onClick={() => setPublishError(null)}
                aria-label="Dismiss"
                className="-mr-1 -mt-0.5 shrink-0 rounded-cta p-1 text-[#c0392b]/70 transition-colors hover:bg-[#f7dede] hover:text-[#c0392b]"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          )}

          {settingUp && !liveUrl && pollExhausted && (
            <div className="mt-4 flex items-center justify-between gap-3 rounded-lg bg-[#fff8e6] px-3 py-2 text-[13px] leading-5 text-[#7a4b00]">
              <span>DNS can take a few minutes to catch up.</span>
              <button
                type="button"
                onClick={checkAgain}
                className="shrink-0 rounded-full border border-[#e6d7a8] bg-white px-2.5 py-1 text-[12px] font-semibold text-[#0e0f11] hover:bg-[#f9f9f9]"
              >
                Check again
              </button>
            </div>
          )}

          {siteEditsPending > 0 && !sitePublishing && !publishing && (
            <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-[#ececec] bg-[#fafafa] px-3 py-2.5">
              <p className="text-[13px] leading-5 text-[#454545]">
                {siteEditsBusy ? SITE_EDITS_APPLYING_HINT : SITE_EDITS_APPLY_HINT}
              </p>
              <button
                type="button"
                onClick={() => void doApplySiteEdits()}
                disabled={siteEditsBusy}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full border border-[#ececec] bg-white px-4 text-[13px] font-semibold text-[#0e0f11] transition-colors hover:bg-[#f9f9f9] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {siteEditsBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                {siteEditsBusy ? "Applying…" : applySiteEditsLabel(siteEditsPending)}
              </button>
            </div>
          )}

          {pendingChanges && pendingChanges.items.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 flex justify-end">
                {siteLiveUrl && (
                  <a
                    href={siteLiveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold text-[#0e0f11] underline-offset-2 hover:underline"
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden /> {COMPARE_WITH_LIVE}
                  </a>
                )}
              </div>
              <ul
                aria-label="Changes ready to publish"
                className="max-h-40 divide-y divide-[#f0f0f0] overflow-y-auto rounded-xl border border-[#ececec]"
              >
                {pendingChanges.items.map((c, i) => (
                  <li key={c.id} className="flex items-center gap-2 px-4 py-2 text-[13px] text-[#0e0f11]">
                    <span className="min-w-0 flex-1 truncate" title={waitingChangeLabel(c)}>
                      {waitingChangeLabel(c)}
                    </span>
                    {i === 0 && c.kind === "edit" && onRequest?.onUndoChange && !sitePublishing && (
                      <button
                        type="button"
                        onClick={() => void undoWaitingChange(c.id)}
                        disabled={undoingChange !== null}
                        aria-label={`Undo: ${waitingChangeLabel(c)}`}
                        className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold text-[#8c8c8c] transition-colors hover:bg-[#f4f4f4] hover:text-[#c0392b] disabled:opacity-50"
                      >
                        {undoingChange === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
                        Undo
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {undoLine && (
                <p role={undoLine.error ? "alert" : "status"} className={`mt-2 text-[12px] leading-5 ${undoLine.error ? "text-[#c0392b]" : "text-[#454545]"}`}>
                  {undoLine.text}
                </p>
              )}
            </div>
          )}

          {onRequest ? (
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => void doSitePublish()}
                disabled={sitePublishing || alreadyPublished || !onRequest.built}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-[#0e0f11] px-4 text-[14px] font-semibold text-white transition-colors hover:bg-[#0e0f11]/85 disabled:cursor-not-allowed disabled:bg-[#0e0f11]/30"
              >
                {sitePublishing && !alreadyPublished && <Loader2 className="h-4 w-4 animate-spin" />}
                {alreadyPublished && <Check className="h-4 w-4" />}
                {alreadyPublished
                  ? "Up to date"
                  : sitePublishing
                    ? SITE_PUBLISHING_TITLE
                    : sitePublishFailed
                      ? "Try again"
                      : sitePublishLive || pendingChanges
                        ? "Publish changes"
                        : "Publish"}
              </button>
            </div>
          ) : confirming ? (
            <div className="mt-4 rounded-xl border border-[#ececec] bg-[#fafafa] p-3">
              <p className="text-[13px] leading-5 text-[#0e0f11]">
                {unpublished || notLiveYet ? (
                  <>
                    This puts your app on the web at a <span className="font-semibold">{baseDomain}</span> address anyone
                    can open. Publish it?
                  </>
                ) : (
                  <>
                    This updates your <span className="font-semibold">live public site</span>. Publish {totalPending} change
                    {totalPending === 1 ? "" : "s"}?
                  </>
                )}
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="inline-flex h-10 items-center justify-center rounded-full border border-[#ececec] bg-white px-4 text-[13px] font-semibold text-[#454545] transition-colors hover:bg-[#f9f9f9]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void doPublish()}
                  className="inline-flex h-10 items-center justify-center rounded-full bg-[#0e0f11] px-4 text-[13px] font-semibold text-white transition-colors hover:bg-[#0e0f11]/85"
                >
                  Publish now
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={!canPublish}
                title={!hasApp && !liveUrl ? "Build your app first" : undefined}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-[#0e0f11] px-4 text-[14px] font-semibold text-white transition-colors hover:bg-[#0e0f11]/85 disabled:cursor-not-allowed disabled:bg-[#0e0f11]/30"
              >
                {publishing && <Loader2 className="h-4 w-4 animate-spin" />}
                {!publishing && (justPublished || publishLabel === "Up to date") && <Check className="h-4 w-4" />}
                {publishLabel}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
