"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { ApiError, approve, newRequestId, redoChannelAction, setChannelAction, type ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { creditRefusalFrom } from "@/lib/workspace/creditRefusal";
import { useChannelChatOpener } from "../actions/channelChat";
import { upgradeOnPlanRefusal, useChannelPlanLock } from "../actions/channelPlanLock";
import { creditsOf, failureReasonOf, RUN_ACTIVE, scriptOf, STARTER_COUNT, starterTileState, useStarterRun, useVideoCreditsEach } from "../actions/StartersPanel";
import { isAnswerCard } from "../actions/StoredPrimary";
import { useChannelActions } from "../actions/useChannelActions";
import { mediaOf } from "../actions/types";
import { hooksOf, splitScript, starterCopy, starterTitle, withoutHook } from "./starterCopy";
import { StudioHero } from "./StudioHero";
import { adDomId, SuggestedAds, type AdItem, type NextStep } from "./SuggestedAds";
import { postOnce, RENDER_POLL_MS, uploadStudioImage, useStudioPromptLoader, writeStudioScript } from "./studioApi";
import { STUDIO_PATH, type StudioMessage, type StudioThread, type StudioView } from "./types";

export const MAX_THREADS = 50;
export const PAGE_SIZE = 6;
export const RELOAD_TRIES = 12;
export const RELOAD_GAVE_UP = "Your change was sent, but Zavi could not load this ad. Refresh the page to see it.";
const STARTER_POLL_MS = 20_000;
const TAP_HOLD_MS = 2 * 60_000;

type ItemError = { text: string; credit: ReturnType<typeof creditRefusalFrom> };

type Pending = {
  key: string;
  text: string;
  image_path: string | null;
  verbatim: boolean;
  title: string;
  statusLine: string;
  startedAt: number;
  error: ItemError | null;
  from?: string;
};

type Editing = { threadId: string; title: string };

export function suggestedCards(actions: ChannelActionView[], hidden: ReadonlySet<string>): ChannelActionView[] {
  return actions
    .filter((a) => a.executable && a.status !== "rejected" && !hidden.has(a.id))
    .sort((a, b) => Date.parse(b.proposed_at) - Date.parse(a.proposed_at));
}

export function nextStepCards(actions: ChannelActionView[], hidden: ReadonlySet<string>): ChannelActionView[] {
  return actions.filter((a) => !a.executable && a.status === "pending" && !hidden.has(a.id));
}

const TITLE_MAX = 60;

export function threadTitle(text: string, image: boolean, presenter = false): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return presenter ? "Presenter video" : image ? "Animated image" : "New video";
  const sentence = t.match(/^[\s\S]{1,59}?[.!?](?=\s|$)/);
  if (sentence) return sentence[0];
  if (t.length <= TITLE_MAX) return t;
  const head = t.slice(0, TITLE_MAX);
  const words = head.replace(/\s+\S*$/, "");
  const cut = words === head ? t.slice(0, TITLE_MAX - 1) : words;
  return `${cut.replace(/[\s,;:]+$/, "")}…`;
}

function statusLineFor(verbatim: boolean, image: boolean): string {
  if (image) return "Making a video from your image.";
  return verbatim ? "Making your ad from your script, word for word." : "Zavi is writing your script…";
}

function lastDraft(view: StudioView): StudioMessage | null {
  for (let i = view.messages.length - 1; i >= 0; i--) if (view.messages[i].draft) return view.messages[i];
  return null;
}

function presenterOf(view: StudioView | null | undefined, image: boolean): boolean {
  return image && !!view && lastDraft(view)?.draft?.intent === "talking_head";
}

type PricedMessage = StudioMessage & { credits?: number | null; verbatim?: boolean };

function lastAssistant(view: StudioView): StudioMessage | null {
  for (let i = view.messages.length - 1; i >= 0; i--) if (view.messages[i].role === "assistant") return view.messages[i];
  return null;
}

export function threadMaking(view: StudioView | undefined): boolean {
  if (!view) return false;
  const m = lastDraft(view);
  return !!m?.render_run_id && view.renders[m.render_run_id]?.status === "rendering";
}

const RENDER_UNCONFIRMED = "Zavi could not confirm this video started. If it did, it will show on this ad in a few minutes, and you are only charged for a video that is made. If nothing shows, press Try again.";

async function readError(res: Response, fallback: string): Promise<{ e: ApiError; item: ItemError }> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  const credit = creditRefusalFrom(body, "video");
  const text = credit?.headline ?? (res.status === 500 ? null : body?.error?.message) ?? fallback;
  return { e: new ApiError(text, res.status, body), item: { text, credit } };
}

function shownError(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.status < 500 && e.message && !/^HTTP \d+$/.test(e.message) ? e.message : fallback;
}

function makingNote(title: string): string {
  return `Making "${title}". This takes a few minutes.`;
}

export function askDraft(title: string, script: string): string {
  const head = `About the AI UGC ad "${title}"`;
  return script.trim() ? `${head}. Its script:\n${script.trim()}\n\n` : `${head}: `;
}

export function VideoOverview({ slug, focusThread = null }: { slug: string; focusThread?: string | null }) {
  const [text, setTextState] = useState("");
  const textRef = useRef("");
  const setText = useCallback((t: string) => {
    textRef.current = t;
    setTextState(t);
  }, []);
  const [attachment, setAttachment] = useState<{ id: number; preview: string | null; path: string | null } | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const uploadSeq = useRef(0);
  const [promptOn, setPromptOn] = useState(false);
  const loadPrompt = useStudioPromptLoader();
  const [editing, setEditing] = useState<Editing | null>(null);
  const openChat = useChannelChatOpener();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [heroKey, setHeroKey] = useState(0);
  const [announcement, setAnnouncement] = useState("");

  const [threads, setThreads] = useState<StudioThread[] | null>(null);
  const [views, setViews] = useState<Record<string, StudioView>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, ItemError | null>>({});
  const [startedHere, setStartedHere] = useState<Record<string, number>>({});
  const [madeHere, setMadeHere] = useState<string[]>([]);
  const [reloading, setReloading] = useState<ReadonlySet<string>>(() => new Set());
  const [behind, setBehind] = useState<ReadonlySet<string>>(() => new Set());
  const markBehind = useCallback((id: string) => setBehind((prev) => (prev.has(id) ? prev : new Set(prev).add(id))), []);
  const [now, setNow] = useState(() => Date.now());
  const [shown, setShown] = useState(PAGE_SIZE);
  const requested = useRef(new Set<string>());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const pendingSeq = useRef(0);
  const inFlight = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const planLock = useChannelPlanLock();
  const writeScript = useCallback(
    async (prompt: string) => {
      try {
        return await writeStudioScript(prompt);
      } catch (e) {
        upgradeOnPlanRefusal(planLock, e);
        throw e;
      }
    },
    [planLock],
  );
  const channel = useChannelActions(slug, { all: true });
  const starter = useStarterRun(slug, true);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const starters = useMemo(() => suggestedCards(channel.actions, hidden), [channel.actions, hidden]);
  const steps = useMemo(() => nextStepCards(channel.actions, hidden), [channel.actions, hidden]);
  const { each } = useVideoCreditsEach(slug);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestedRun, setSuggestedRun] = useState<string | null>(null);
  const [suggestError, setSuggestError] = useState<ItemError | null>(null);
  const [approvedHere, setApprovedHere] = useState<ReadonlyMap<string, ChannelActionView["exec_status"]>>(() => new Map());
  const tappedAt = useRef(new Map<string, number>());
  useEffect(() => {
    setApprovedHere((prev) => {
      let next: Map<string, ChannelActionView["exec_status"]> | null = null;
      for (const a of channel.actions) {
        const stale = Date.now() - (tappedAt.current.get(a.id) ?? 0) > TAP_HOLD_MS;
        if (prev.has(a.id) && (prev.get(a.id) !== a.exec_status || stale)) {
          next ??= new Map(prev);
          next.delete(a.id);
        }
      }
      return next ?? prev;
    });
  }, [channel.actions]);

  const fetchView = useCallback(async (id: string): Promise<StudioView | null> => {
    try {
      const res = await apiFetch(`${STUDIO_PATH}?thread_id=${encodeURIComponent(id)}`);
      if (!res.ok) return null;
      const view = (await res.json()) as StudioView;
      if (alive.current) {
        setViews((prev) => ({ ...prev, [id]: view }));
        setBehind((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
      return view;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch(`${STUDIO_PATH}/threads`);
        if (!res.ok) {
          if (alive.current) {
            setLoadError("Your ads could not be loaded. Refresh the page.");
            setThreads([]);
          }
          return;
        }
        const body = (await res.json()) as { threads?: StudioThread[] };
        const list = (body.threads ?? []).slice(0, MAX_THREADS);
        if (alive.current) setThreads((cur) => [...(cur ?? []).filter((c) => !list.some((t) => t.id === c.id)), ...list]);
      } catch {
        if (alive.current) {
          setLoadError("Could not reach Zavi. Check your connection.");
          setThreads([]);
        }
      }
    })();
  }, [fetchView]);

  const makingIds = useMemo(() => Object.keys(views).filter((id) => threadMaking(views[id])).sort().join(","), [views]);
  useEffect(() => {
    if (!makingIds) return;
    const id = setInterval(() => {
      for (const t of makingIds.split(",")) void fetchView(t);
    }, RENDER_POLL_MS);
    return () => clearInterval(id);
  }, [makingIds, fetchView]);

  const reloadIds = [...reloading].sort().join(",");
  const reloadBusy = useRef(new Set<string>());
  const reloadTries = useRef(new Map<string, number>());
  useEffect(() => {
    if (!reloadIds) return;
    const stop = (t: string) => {
      reloadTries.current.delete(t);
      setReloading((prev) => {
        const next = new Set(prev);
        next.delete(t);
        return next;
      });
      setStartedHere((cur) => ({ ...cur, [t]: 0 }));
    };
    const id = setInterval(() => {
      for (const t of reloadIds.split(",")) {
        if (reloadBusy.current.has(t)) continue;
        const tries = (reloadTries.current.get(t) ?? 0) + 1;
        if (tries > RELOAD_TRIES) {
          stop(t);
          setErrors((cur) => ({ ...cur, [`thread-${t}`]: { text: RELOAD_GAVE_UP, credit: null } }));
          continue;
        }
        reloadTries.current.set(t, tries);
        reloadBusy.current.add(t);
        void fetchView(t)
          .then((v) => {
            if (!v || !alive.current) return;
            stop(t);
          })
          .finally(() => reloadBusy.current.delete(t));
      }
    }, RENDER_POLL_MS);
    return () => clearInterval(id);
  }, [reloadIds, fetchView]);

  const startersMaking = starters.some((c) => starterTileState(c, approvedHere) === "making");
  const { refreshSilent } = channel;
  useEffect(() => {
    if (!startersMaking) return;
    const id = setInterval(() => void refreshSilent(), STARTER_POLL_MS);
    return () => clearInterval(id);
  }, [startersMaking, refreshSilent]);

  const runCards = starter.runId === null ? 0 : channel.actions.filter((a) => a.executable && a.run_id === starter.runId).length;
  const writing =
    starter.runId !== null && (starter.runStatus == null ? suggestedRun === starter.runId : RUN_ACTIVE.has(starter.runStatus));
  const writingCount = writing ? Math.max(0, STARTER_COUNT - runCards) : 0;
  const { reload: reloadRun } = starter;
  useEffect(() => {
    if (!writing) return;
    const id = setInterval(() => {
      reloadRun?.();
      void refreshSilent();
    }, STARTER_POLL_MS);
    return () => clearInterval(id);
  }, [writing, reloadRun, refreshSilent]);

  const ticking = writing || pending.some((p) => !p.error) || makingIds !== "" || reloadIds !== "" || startersMaking;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  const scrollTo = (key: string) => {
    requestAnimationFrame(() => document.getElementById(adDomId(key))?.scrollIntoView?.({ behavior: "smooth", block: "start" }));
  };

  const freshStarters = starter.runId === null ? [] : starters.filter((c) => c.run_id === starter.runId);
  const olderStarters = starters.filter((c) => !freshStarters.includes(c));
  const leading = pending.length + writingCount + freshStarters.length;
  const threadBudget = Math.max(0, shown - leading);
  const feed = useMemo(
    () =>
      [
        ...(threads ?? []).filter((thread) => !hidden.has(thread.id)).map((thread) => ({ thread, at: Date.parse(thread.last_message_at) || 0 })),
        ...olderStarters.map((starterCard) => ({ starterCard, at: Date.parse(starterCard.proposed_at) || 0 })),
      ].sort((a, b) => b.at - a.at),
    [threads, starters, starter.runId, hidden],
  );
  const feedShown = feed.slice(0, threadBudget);
  const shownThreads = feedShown.flatMap((e) => ("thread" in e ? [e.thread] : []));
  const wantedKey = shownThreads.map((t) => t.id).join("|");
  const wantedThreads = useMemo(() => (wantedKey ? wantedKey.split("|") : []), [wantedKey]);
  useEffect(() => {
    for (const id of wantedThreads) {
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      void fetchView(id)
        .then((v) => v ?? fetchView(id))
        .then((v) => {
          if (!v && alive.current) setFailed((prev) => new Set(prev).add(id));
        });
    }
  }, [wantedThreads, fetchView]);

  const focusIndex = focusThread && threads ? feed.findIndex((e) => "thread" in e && e.thread.id === focusThread) : -1;
  const focusMissing = !!focusThread && threads !== null && focusIndex === -1;
  useEffect(() => {
    if (!focusMissing || !focusThread || requested.current.has(focusThread)) return;
    requested.current.add(focusThread);
    void fetchView(focusThread).then((v) => {
      if (!alive.current) return;
      if (!v) {
        setFailed((prev) => new Set(prev).add(focusThread));
        return;
      }
      const first = v.messages.find((m) => m.role === "user");
      const entry = { id: focusThread, title: threadTitle(first?.body ?? "", !!first?.image_path, presenterOf(v, !!first?.image_path)), last_message_at: v.messages[v.messages.length - 1]?.created_at ?? new Date(0).toISOString() };
      setThreads((cur) => (cur && !cur.some((t) => t.id === focusThread) ? [...cur, entry] : cur));
    });
  }, [focusMissing, focusThread, fetchView]);
  useEffect(() => {
    if (focusIndex >= threadBudget) setShown(leading + focusIndex + 1);
  }, [focusIndex, threadBudget, leading]);
  const focusReady = focusThread ? !!views[focusThread] : false;
  useEffect(() => {
    if (focusThread && focusReady) scrollTo(`thread-${focusThread}`);
  }, [focusThread, focusReady]);

  const attach = async (file: File) => {
    const id = ++uploadSeq.current;
    let preview: string | null = null;
    try {
      preview = URL.createObjectURL(file);
    } catch {
      preview = null;
    }
    setAttachError(null);
    setAttachment({ id, preview, path: null });
    try {
      const path = await uploadStudioImage(file);
      if (uploadSeq.current === id) setAttachment((a) => (a && a.id === id ? { ...a, path } : a));
    } catch (e) {
      if (uploadSeq.current !== id) return;
      setAttachment(null);
      setAttachError((e as Error).message);
    }
  };

  const send = async (p: Pending, threadId: string | null): Promise<boolean> => {
    const body = JSON.stringify({
      text: p.text,
      ...(p.image_path ? { image_path: p.image_path } : {}),
      ...(p.verbatim && !p.image_path ? { verbatim: true } : {}),
      ...(threadId ? { thread_id: threadId } : { new_thread: true }),
    });
    const clearMaking = (next = "") => {
      if (alive.current) setAnnouncement((cur) => (cur === makingNote(p.title) ? next : cur));
    };
    let failure: ItemError;
    try {
      const res = await postOnce(`${STUDIO_PATH}/messages`, body);
      if (res.ok) {
        const out = (await res.json()) as {
          thread_id: string;
          reply?: { body?: unknown } | null;
          render?: { run_id?: unknown; error?: unknown } | null;
        };
        const started = !!out.render && typeof out.render.run_id === "string";
        const fresh = (await fetchView(out.thread_id)) ?? (await fetchView(out.thread_id));
        if (!alive.current) return started;
        if (!started) {
          const why = typeof out.render?.error === "string" ? out.render.error : typeof out.reply?.body === "string" ? out.reply.body : "";
          clearMaking(why ? `Zavi did not make "${p.title}". ${why}` : `Zavi did not make "${p.title}".`);
        }
        const title = threadTitle(p.text, !!p.image_path, presenterOf(fresh, !!p.image_path));
        setThreads((cur) => {
          const rest = (cur ?? []).filter((t) => t.id !== out.thread_id);
          const prior = (cur ?? []).find((t) => t.id === out.thread_id);
          return [prior ?? { id: out.thread_id, title, last_message_at: new Date().toISOString() }, ...rest];
        });
        setPending((cur) => cur.filter((x) => x.key !== p.key));
        if (!threadId) setMadeHere((cur) => [out.thread_id, ...cur.filter((id) => id !== out.thread_id)]);
        if (threadId && !fresh) {
          reloadTries.current.delete(threadId);
          markBehind(threadId);
          setReloading((prev) => new Set(prev).add(threadId));
        }
        else if (threadId) setStartedHere((cur) => ({ ...cur, [threadId]: 0 }));
        return started;
      }
      const { e, item } = await readError(res, "Zavi could not start this video. Try again.");
      if (upgradeOnPlanRefusal(planLock, e)) {
        clearMaking();
        if (alive.current) setPending((cur) => cur.filter((x) => x.key !== p.key));
        if (threadId) setStartedHere((cur) => ({ ...cur, [threadId]: 0 }));
        return false;
      }
      failure = item;
    } catch {
      failure = { text: "Could not reach Zavi. Check your connection.", credit: null };
    }
    if (!alive.current) return false;
    clearMaking();
    if (threadId) {
      setStartedHere((cur) => ({ ...cur, [threadId]: 0 }));
      setErrors((cur) => ({ ...cur, [`thread-${threadId}`]: failure }));
    } else {
      setPending((cur) => cur.map((x) => (x.key === p.key ? { ...x, error: failure } : x)));
    }
    return false;
  };

  const submit = ({ verbatim, revise = false }: { verbatim: boolean; revise?: boolean }) => {
    const t = textRef.current.trim();
    const image_path = revise ? null : attachment?.path ?? null;
    if (!revise && attachment && !image_path) return;
    if (!t && !image_path) return;
    textRef.current = "";
    const target = editing;
    const p: Pending = {
      key: `pending-${++pendingSeq.current}`,
      text: t,
      image_path,
      verbatim,
      title: target ? target.title : threadTitle(t, !!image_path),
      statusLine: statusLineFor(verbatim && !image_path, !!image_path),
      startedAt: Date.now(),
      error: null,
    };
    setText("");
    if (!revise) {
      uploadSeq.current++;
      setAttachment(null);
      setAttachError(null);
    }
    setEditing(null);
    setPromptOn(false);
    launch(p, target);
  };

  const makeScript = (text: string, target: Editing | null, title: string, from?: string, verbatim = true): Promise<boolean> => {
    const t = text.trim();
    if (!t) return Promise.resolve(false);
    return launch(
      {
        key: `pending-${++pendingSeq.current}`,
        text: t,
        image_path: null,
        verbatim,
        title,
        statusLine: statusLineFor(verbatim, false),
        startedAt: Date.now(),
        error: null,
        from,
      },
      target,
    );
  };

  const launch = (p: Pending, target: Editing | null) => {
    setNow(Date.now());
    setAnnouncement(makingNote(p.title));
    if (target) {
      setErrors((cur) => ({ ...cur, [`thread-${target.threadId}`]: null }));
      setStartedHere((cur) => ({ ...cur, [target.threadId]: p.startedAt }));
      scrollTo(`thread-${target.threadId}`);
    } else {
      setPending((cur) => [p, ...cur]);
      if (p.from) setHidden((prev) => new Set(prev).add(p.from!));
      scrollTo(p.key);
    }
    return send(p, target?.threadId ?? null);
  };

  const focusComposer = () => {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.scrollIntoView?.({ behavior: "smooth", block: "center" });
    });
  };

  const retryRender = async (threadId: string, messageId: string) => {
    const key = `thread-${threadId}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setBusy((cur) => ({ ...cur, [key]: true }));
    setErrors((cur) => ({ ...cur, [key]: null }));
    try {
      const res = await postOnce(`${STUDIO_PATH}/render`, JSON.stringify({ message_id: messageId, thread_id: threadId }));
      if (!res.ok) {
        const { e, item } = await readError(res, "Zavi could not start this video. Try again.");
        const code = (e.body as { error?: { code?: unknown } } | null)?.error?.code;
        const shown = res.status === 500 || (res.status > 500 && !code) ? { ...item, text: RENDER_UNCONFIRMED } : item;
        if (!upgradeOnPlanRefusal(planLock, e) && alive.current) setErrors((cur) => ({ ...cur, [key]: shown }));
        if (res.status === 409 && code === "superseded" && alive.current) markBehind(threadId);
        if (res.status === 409) await fetchView(threadId);
        if (shown.text === RENDER_UNCONFIRMED) {
          const v = await fetchView(threadId);
          const run = v ? lastDraft(v)?.render_run_id : null;
          const status = v && run ? v.renders[run]?.status : undefined;
          if ((status === "rendering" || status === "done") && alive.current) setErrors((cur) => ({ ...cur, [key]: null }));
        }
      } else if (!(await fetchView(threadId)) && alive.current) {
        reloadTries.current.delete(threadId);
        markBehind(threadId);
        setStartedHere((cur) => ({ ...cur, [threadId]: Date.now() }));
        setReloading((prev) => new Set(prev).add(threadId));
      }
    } catch {
      if (alive.current) setErrors((cur) => ({ ...cur, [key]: { text: "Could not reach Zavi. Check your connection.", credit: null } }));
    } finally {
      inFlight.current.delete(key);
      if (alive.current) setBusy((cur) => ({ ...cur, [key]: false }));
    }
  };

  const makeStarter = async (card: ChannelActionView) => {
    const key = `starter-${card.id}`;
    if (inFlight.current.has(key)) return;
    if (planLock?.tierName) {
      planLock.upgrade();
      return;
    }
    inFlight.current.add(key);
    setBusy((cur) => ({ ...cur, [key]: true }));
    setErrors((cur) => ({ ...cur, [key]: null }));
    try {
      await approve(card.id, newRequestId());
      tappedAt.current.set(card.id, Date.now());
      setApprovedHere((prev) => new Map(prev).set(card.id, card.exec_status));
      setAnnouncement(`Making "${starterTitle(card)}". This takes a few minutes.`);
      void refreshSilent();
    } catch (e) {
      if (upgradeOnPlanRefusal(planLock, e)) return;
      const credit = creditRefusalFrom(e instanceof ApiError ? e.body : null, "video");
      if (alive.current) setErrors((cur) => ({ ...cur, [key]: { text: credit?.headline ?? shownError(e, "Zavi could not start this video. Try again."), credit } }));
    } finally {
      inFlight.current.delete(key);
      if (alive.current) setBusy((cur) => ({ ...cur, [key]: false }));
    }
  };

  const suggestAds = async () => {
    if (inFlight.current.has("suggest")) return;
    if (planLock?.tierName) {
      planLock.upgrade();
      return;
    }
    inFlight.current.add("suggest");
    setSuggesting(true);
    setSuggestError(null);
    try {
      const res = await apiFetch(`/api/channels/${slug}/starters`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = (await res.json().catch(() => null)) as { run_id?: unknown; error?: { code?: string; message?: string } } | null;
      if (!res.ok) {
        const e = new ApiError(body?.error?.message ?? "Zavi could not suggest new ads.", res.status, body);
        if (upgradeOnPlanRefusal(planLock, e)) return;
        const credit = creditRefusalFrom(body, "channel");
        if (alive.current) setSuggestError({ text: credit?.headline ?? (res.status < 500 || body?.error?.code === "video_unavailable" ? body?.error?.message : null) ?? "Zavi could not suggest new ads. Try again.", credit });
        return;
      }
      const runId = typeof body?.run_id === "string" ? body.run_id : null;
      starter.setRunId(runId);
      setSuggestedRun(runId);
      void refreshSilent();
    } catch {
      if (alive.current) setSuggestError({ text: "Could not reach Zavi. Check your connection.", credit: null });
    } finally {
      inFlight.current.delete("suggest");
      if (alive.current) setSuggesting(false);
    }
  };

  const settle = async (card: ChannelActionView, action: "acted" | "rejected") => {
    const key = `card-${card.id}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setBusy((cur) => ({ ...cur, [key]: true }));
    setErrors((cur) => ({ ...cur, [key]: null }));
    try {
      await setChannelAction(card.id, { action });
      if (!alive.current) return;
      setHidden((prev) => new Set(prev).add(card.id));
      void refreshSilent();
    } catch {
      if (alive.current) setErrors((cur) => ({ ...cur, [key]: { text: "Zavi could not save that. Try again.", credit: null } }));
    } finally {
      inFlight.current.delete(key);
      if (alive.current) setBusy((cur) => ({ ...cur, [key]: false }));
    }
  };

  const answerCard = async (card: ChannelActionView, note: string): Promise<boolean> => {
    const key = `card-${card.id}`;
    if (inFlight.current.has(key)) return false;
    inFlight.current.add(key);
    setBusy((cur) => ({ ...cur, [key]: true }));
    setErrors((cur) => ({ ...cur, [key]: null }));
    try {
      await redoChannelAction(card.id, note, "answer");
      if (!alive.current) return true;
      setHidden((prev) => new Set(prev).add(card.id));
      void refreshSilent();
      return true;
    } catch (e) {
      if (!upgradeOnPlanRefusal(planLock, e) && alive.current) setErrors((cur) => ({ ...cur, [key]: { text: "Zavi could not send that. Try again.", credit: null } }));
      return false;
    } finally {
      inFlight.current.delete(key);
      if (alive.current) setBusy((cur) => ({ ...cur, [key]: false }));
    }
  };

  const editScript = (script: string, target: Editing | null, prompt = false) => {
    uploadSeq.current++;
    setAttachment(null);
    setAttachError(null);
    setText(script);
    setPromptOn(prompt);
    setEditing(target);
    setHeroKey((k) => k + 1);
    focusComposer();
  };

  const pendingItems: AdItem[] = pending.map((p): AdItem => {
    const own = p.verbatim || !!p.image_path;
    const split = own ? splitScript(p.text) : { hook: null, rest: "" };
    const request = !own && !!p.error;
    return {
      key: p.key,
      title: p.title,
      hooks: split.hook ? [split.hook] : [],
      script: request ? p.text : split.rest,
      prompt: request,
      hookless: request,
      note: own || request ? null : p.text,
      state: p.error ? "failed" : "making",
      startedAt: p.startedAt,
      statusLine: p.statusLine,
      error: p.error,
      intent: p.verbatim && !p.image_path ? "talking_head" : null,
      onMakeScript:
        p.error && !p.image_path
          ? (text: string) => {
              const again = { ...p, text: text.trim(), error: null, startedAt: Date.now() };
              setPending((cur) => cur.map((x) => (x.key === p.key ? again : x)));
              void send(again, null);
            }
          : undefined,
      onRetry: p.error
        ? () => {
            const again = { ...p, error: null, startedAt: Date.now() };
            setPending((cur) => cur.map((x) => (x.key === p.key ? again : x)));
            void send(again, null);
          }
        : undefined,
      onDismiss: p.error
        ? () => {
            setPending((cur) => cur.filter((x) => x.key !== p.key));
            if (p.from)
              setHidden((prev) => {
                const next = new Set(prev);
                next.delete(p.from!);
                return next;
              });
          }
        : undefined,
    };
  });

  const threadItems: AdItem[] = shownThreads.flatMap((t): AdItem[] => {
    const view = views[t.id];
    if (!view) return [];
    const key = `thread-${t.id}`;
    const draftMsg = lastDraft(view);
    const ask = () => {
      const latest = lastDraft(view)?.draft;
      const script = latest ? (latest.script ?? latest.visual) : "";
      if (openChat) {
        openChat({ target: "channel", draft: { text: askDraft(t.title, script), nonce: Date.now() } });
        return;
      }
      setEditing({ threadId: t.id, title: t.title });
      setPromptOn(true);
      focusComposer();
    };
    const restarted = startedHere[t.id];
    const stale = behind.has(t.id);
    if (!draftMsg) {
      const asked = view.messages.find((m) => m.role === "user") as PricedMessage | undefined;
      const words = asked && !asked.image_path ? asked.body.trim() : "";
      const verbatim = asked?.verbatim === true;
      const failedDraft = !restarted && lastAssistant(view)?.kind === "video_studio_draft_failed";
      const ownThread = madeHere.includes(t.id);
      return [{
        key,
        title: t.title,
        hooks: [],
        script: words,
        prompt: !!words,
        hookless: !!words,
        note: restarted ? null : lastAssistant(view)?.body ?? null,
        state: restarted ? "making" : "failed",
        startedAt: restarted || undefined,
        error: errors[key] ?? null,
        onMakeScript: words ? (text: string) => makeScript(text, { threadId: t.id, title: t.title }, t.title, undefined, verbatim) : undefined,
        onEdit: words ? undefined : () => editScript(asked?.body ?? "", { threadId: t.id, title: t.title }, true),
        onRetry:
          failedDraft && asked
            ? () =>
                void launch(
                  {
                    key: `pending-${++pendingSeq.current}`,
                    text: asked.body.trim(),
                    image_path: asked.image_path ?? null,
                    verbatim: verbatim && !asked.image_path,
                    title: t.title,
                    statusLine: statusLineFor(verbatim && !asked.image_path, !!asked.image_path),
                    startedAt: Date.now(),
                    error: null,
                  },
                  { threadId: t.id, title: t.title },
                )
            : undefined,
        onDismiss: ownThread && !restarted ? () => setHidden((prev) => new Set(prev).add(t.id)) : undefined,
        onAsk: ask,
      }];
    }
    const draft = draftMsg.draft!;
    const full = draft.script ?? draft.visual;
    const split = draft.hook ? { hook: draft.hook, rest: withoutHook(full, draft.hook) } : splitScript(full);
    const render = draftMsg.render_run_id ? view.renders[draftMsg.render_run_id] : undefined;
    const done = render?.status === "done" && !!render.videos[0];
    const last = lastAssistant(view);
    const refused =
      last && !last.draft && Date.parse(last.created_at) > Date.parse(draftMsg.created_at) && (last.kind === "video_studio_refused" || last.kind === "video_studio_draft_failed")
        ? last.body
        : null;
    const base = {
      key,
      title: t.title,
      hooks: hooksOf(split.hook, draft.alt_hooks),
      script: split.rest,
      hookless: !draft.hook && !draft.alt_hooks?.length,
      note: refused,
      error: errors[key] ?? null,
      busy: busy[key],
      cost: (draftMsg as PricedMessage).credits ?? null,
      intent: draft.intent,
      onMakeScript: draft.script ? (text: string) => makeScript(text, done ? null : { threadId: t.id, title: t.title }, t.title) : undefined,
      onEdit: draft.script ? undefined : () => editScript(view.messages.find((m) => m.role === "user")?.body ?? "", { threadId: t.id, title: t.title }, true),
      onAsk: ask,
    };
    if (restarted) {
      return [{ ...base, note: null, state: "making", startedAt: restarted }];
    }
    if (render?.status === "rendering") {
      return [{ ...base, state: "making", queued: render.queued === true, startedAt: Date.parse(render.working_since ?? render.started_at) }];
    }
    if (done) {
      const revise = draft.script
        ? (line: string) =>
            launch(
              {
                key: `pending-${++pendingSeq.current}`,
                text: line,
                image_path: null,
                verbatim: false,
                title: t.title,
                statusLine: statusLineFor(false, false),
                startedAt: Date.now(),
                error: null,
              },
              { threadId: t.id, title: t.title },
            )
        : undefined;
      return [{ ...base, state: "ready", video: { artifactId: render!.videos[0].artifact_id }, onRevise: revise }];
    }
    if (!draftMsg.render_run_id && !refused) {
      return [{ ...base, state: "draft", onMake: stale ? undefined : () => void retryRender(t.id, draftMsg.id) }];
    }
    const noCredits = render?.status === "failed" && render.code === "insufficient_credits";
    return [{
      ...base,
      state: "failed",
      stalled: !refused && render?.status === "stalled",
      note:
        errors[key]?.text === RENDER_UNCONFIRMED
          ? null
          : refused ??
        (render?.status === "stalled"
          ? "This video is taking much longer than usual. Press Try again to check on it: if it is still being made, Zavi keeps that same video, and you are charged once, only when it arrives."
          : noCredits
            ? "Not enough credits for this video. Nothing was charged."
            : render?.status === "failed"
              ? (last?.run_id === draftMsg.render_run_id && last.kind?.endsWith("_failed") ? last.body : "Couldn't make this one. You were not charged.")
              : null),
      topUp: noCredits,
      onRetry: stale || (refused && last?.kind === "video_studio_refused") ? undefined : () => void retryRender(t.id, draftMsg.id),
    }];
  });

  const starterItem = (card: ChannelActionView): AdItem => {
    const key = `starter-${card.id}`;
    const tile = starterTileState(card, approvedHere);
    const media = mediaOf(card);
    const full = scriptOf(card);
    const { title, hooks, script } = starterCopy(card);
    const ask = () => {
      if (openChat) {
        openChat({ target: "channel", draft: { text: askDraft(title, full), nonce: Date.now() } });
        return;
      }
      setEditing(null);
      setPromptOn(true);
      focusComposer();
    };
    const base = {
      key,
      title,
      hooks,
      script,
      error: errors[key] ?? errors[`card-${card.id}`] ?? null,
      busy: busy[key] || busy[`card-${card.id}`],
      cost: creditsOf(card, each),
      intent: "talking_head" as const,
      onMakeScript: (text: string) => makeScript(text, null, title, card.id),
      onAsk: ask,
    };
    if (tile === "ready" && media?.kind === "video")
      return { ...base, state: "ready", video: { url: media.url, downloadUrl: media.downloadUrl }, onMakeScript: (text: string) => makeScript(text, null, title) };
    if (tile === "making") return { ...base, state: "making", free: !!starter.firstVideoActionId && starter.firstVideoActionId === card.id, startedAt: tappedAt.current.get(card.id) ?? (Date.parse(card.proposed_at) || undefined) };
    if (tile === "failed") {
      const retryable = card.exec_code === "insufficient_credits" || card.exec_bucket === "temporary";
      return {
        ...base,
        state: "failed",
        note: card.exec_code === "insufficient_credits" ? "Not enough credits for this video. Nothing was charged." : failureReasonOf(card) ?? "Couldn't make this one. You were not charged.",
        topUp: card.exec_code === "insufficient_credits",
        onRetry: retryable ? () => void makeStarter(card) : undefined,
      };
    }
    return { ...base, state: "draft", onMake: () => void makeStarter(card) };
  };
  const freshItems = freshStarters.map(starterItem);

  const writingItems: AdItem[] = Array.from({ length: writingCount }, (_, i): AdItem => ({
    key: `writing-${i}`,
    title: "New suggested ad",
    hooks: [],
    script: "",
    state: "making",
    writing: true,
    statusLine: "Writing the script…",
  }));

  const stepItems: NextStep[] = steps.map((card) => {
    const key = `card-${card.id}`;
    const step = (card.body as { step?: { body?: unknown } } | undefined)?.step;
    const answer = isAnswerCard(card);
    return {
      key,
      title: card.title,
      body: typeof step?.body === "string" && step.body.trim() ? step.body.trim() : null,
      doneLabel: answer ? card.primary_label || "Reply" : card.done_label || "Mark done",
      busy: busy[key],
      error: errors[key]?.text ?? null,
      onDone: () => void settle(card, "acted"),
      onDismiss: () => void settle(card, "rejected"),
      onAnswer: answer ? (note) => answerCard(card, note) : undefined,
    };
  });

  const waitingAds = starters.filter((c) => starterTileState(c, approvedHere) === "waiting").length;
  const suggestHint = writing
    ? "Zavi is writing new ads for your business."
    : suggesting
      ? null
      : starter.lastEmpty
        ? waitingAds > 0
          ? "No new ads: each format already has an ad waiting. Make or dismiss one to get new ideas."
          : "The last suggestion finished without any ads. If Zavi needs you above, do that first."
        : starter.failedAttempts > 0
          ? "The last suggestion did not finish. You are charged only for videos that arrive."
          : starter.firstVideoUsed
            ? null
            : "Zavi writes a few ads and makes the first one right away. It is charged only if it arrives.";

  const madeItems = threadItems.filter((i) => i.state === "making" || madeHere.some((id) => i.key === `thread-${id}`));
  const earlierItems = threadItems.filter((i) => !madeItems.includes(i));
  const recentItems = feedShown.flatMap((e): AdItem[] => {
    if ("starterCard" in e) return [starterItem(e.starterCard)];
    return earlierItems.filter((i) => i.key === `thread-${e.thread.id}`);
  });
  const items = [...pendingItems, ...madeItems, ...writingItems, ...freshItems, ...recentItems];
  const total = leading + feed.length;
  const unloaded = wantedThreads.filter((id) => !views[id] && !failed.has(id)).length;
  const loadMore = useCallback(() => setShown((n) => n + PAGE_SIZE), []);
  const editingView = editing ? views[editing.threadId] : undefined;
  const editingDraft = editingView ? lastDraft(editingView) : null;
  const editingRender = editingView && editingDraft?.render_run_id ? editingView.renders[editingDraft.render_run_id] : undefined;
  const editingReady = editingRender?.status === "done" && !!editingRender.videos[0];
  const uploading = attachment !== null && attachment.path === null;

  return (
    <div data-testid="video-overview" className="flex flex-col">
      <p role="status" data-testid="video-overview-status" className="sr-only">
        {announcement}
      </p>
      <StudioHero
        key={heroKey}
        text={text}
        setText={setText}
        sending={false}
        attachment={attachment}
        attachError={attachError}
        onAttach={(f) => void attach(f)}
        onRemoveAttachment={() => {
          uploadSeq.current++;
          setAttachment(null);
        }}
        onSubmit={(o) => {
          if (o.revise || !uploading) submit(o);
        }}
        onWriteScript={writeScript}
        onLoadPrompt={loadPrompt}
        inputRef={inputRef}
        promptOn={promptOn}
        onPromptOnChange={setPromptOn}
        editing={editing ? { title: editing.title, ready: editingReady, onClear: () => setEditing(null) } : null}
        listBelow
      />
      <SuggestedAds
        items={items}
        loading={threads === null}
        error={
          loadError ??
          (channel.error ? "Your video ideas could not be loaded. Refresh the page." : failed.size > 0 ? "Some of your ads could not be loaded. Refresh the page." : null)
        }
        now={now}
        steps={stepItems}
        more={threads !== null && shown < total ? loadMore : null}
        loadingMore={threads !== null ? Math.min(unloaded, 2) : 0}
        suggest={starter.loaded ? { busy: suggesting || writing, writing: !suggesting && writing, onSuggest: () => void suggestAds(), hint: suggestHint, error: suggestError } : null}
        announce={setAnnouncement}
      />
    </div>
  );
}
