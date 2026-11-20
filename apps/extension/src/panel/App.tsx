
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  ApiError,
  TERMINAL,
  awaitAnswer,
  fetchApprovals,
  fetchHistory,
  fetchRunStatus,
  fetchRunProgress,
  type ProgressItem,
  sendChat,
  uploadScreenshot,
  type ChatMessage,
  type Decision,
  type ScreenshotPageContext,
} from "./api";
import {
  hasPageAccess,
  requestPageAccess,
  type TabInfo,
} from "./capture";
import { captureActiveTab, type CaptureOutcome } from "./screenshot";
import {
  CONSENT_REQUIRED_CODE,
  getConsent,
  grantConsent,
  revokeConsent,
} from "./consent";
import {
  RUN_STATUS_EVERY_N_POLLS,
  THREAD_IDLE_POLL_MS,
  THREAD_IDLE_POLL_WINDOW_MS,
} from "../shared/config";
import { ConsentScreen } from "./components/ConsentScreen";
import { SettingsScreen } from "./components/SettingsScreen";
import { signOut } from "./auth";
import { supabase } from "./supabase";
import {
  dismissFirstRun,
  firstRunDismissed,
  getTabThread,
  setTabThread,
} from "../shared/tab-state";
import { ownTabId } from "./own-tab";
import { nextSteps } from "./progress-state";
import { Composer } from "./components/Composer";
import { Header } from "./components/Header";
import { MessageList, type TurnPhase } from "./components/MessageList";
import { SignIn } from "./components/SignIn";
import { WorkingBar } from "./components/WorkingBar";
import { BrowserControl, type ControlState } from "./executor/control";

export const UNCAPTURABLE_NOTE = "Can't capture this page, sent text only.";
export const DAILY_CAP_NOTE =
  "You've reached today's limit for screenshots sent from the extension. Nothing was sent. Try again tomorrow.";
const DAILY_CAP_CODE = "extension_daily_cap";

export function App(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const [ownTab, setOwnTab] = useState<number | null>(null);
  const ownTabRef = useRef<number | null>(null);
  const restoredRef = useRef(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [threadId, setThreadIdState] = useState<string | null>(null);
  const threadIdRef = useRef<string | null>(null);
  const setThreadId = useCallback((id: string | null) => {
    threadIdRef.current = id;
    setThreadIdState(id);
    const owner = ownTabRef.current;
    if (owner !== null) void setTabThread(owner, id);
  }, []);
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [approvals, setApprovals] = useState<Decision[]>([]);
  const [workingRunId, setWorkingRunId] = useState<string | null>(null);
  const lastActivityRef = useRef<number>(Date.now());

  const [consentPrompt, setConsentPrompt] = useState<{ text: string } | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);
  const [chromeDenied, setChromeDenied] = useState(false);
  const [firstRun, setFirstRun] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const liveDraftRef = useRef<string | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [turnOffBusy, setTurnOffBusy] = useState(false);
  const [turnOffError, setTurnOffError] = useState<string | null>(null);
  const [turnedOff, setTurnedOff] = useState(false);
  const [clearedCount, setClearedCount] = useState<number | null>(null);

  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [turnPhase, setTurnPhase] = useState<TurnPhase | null>(null);
  const [steps, setSteps] = useState<ProgressItem[]>([]);
  const turnSeqRef = useRef(0);
  const progressInFlightRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const controlRef = useRef<BrowserControl | null>(null);
  const [control, setControl] = useState<ControlState>({
    working: false,
    lines: [],
    stopped: false,
  });
  const [controlKey, setControlKey] = useState(0);
  const signedInUser = session?.user?.id ?? null;

  useEffect(() => {
    let alive = true;
    void supabase()
      .auth.getSession()
      .then(({ data }) => {
        if (!alive) return;
        setSession(data.session ?? null);
        setAuthReady(true);
      });
    const { data: sub } = supabase().auth.onAuthStateChange((_e, s) => {
      setSession(s ?? null);
      setAuthReady(true);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const id = ownTabId();
    ownTabRef.current = id;
    setOwnTab(id);
  }, []);

  useEffect(() => {
    if (!session || ownTab === null || restoredRef.current) return;
    restoredRef.current = true;
    let alive = true;
    void (async () => {
      const saved = await getTabThread(ownTab);
      if (!saved || !alive) return;
      if (threadIdRef.current !== null) return;
      setThreadId(saved);
      try {
        const { data } = await supabase().auth.getSession();
        const token = data.session?.access_token;
        if (!token || !alive) return;
        const h = await fetchHistory(token, saved);
        if (alive && threadIdRef.current === saved) setMessages(h.messages);
      } catch {
      }
    })();
    return () => {
      alive = false;
    };
  }, [session, ownTab, setThreadId]);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    void (async () => {
      try {
        if (await firstRunDismissed()) return;
        const { data } = await supabase().auth.getSession();
        const token = data.session?.access_token;
        if (!token) return;
        const [reply, hasAccess] = await Promise.all([
          getConsent(token),
          hasPageAccess(),
        ]);
        if (!alive) return;
        if (reply.consent_required || !hasAccess) setFirstRun(true);
      } catch {
      }
    })();
    return () => {
      alive = false;
    };
  }, [session]);

  const refreshTab = useCallback(async () => {
    const own = ownTabRef.current;
    if (own === null) {
      setTab(null);
      return;
    }
    try {
      const t = await chrome.tabs.get(own);
      setTab(
        t && typeof t.id === "number" && t.url
          ? { tabId: t.id, url: t.url, title: t.title ?? t.url }
          : null,
      );
    } catch {
      setTab(null);
    }
  }, []);

  useEffect(() => {
    void refreshTab();
    const onActivated = () => void refreshTab();
    const onUpdated = (_id: number, change: chrome.tabs.TabChangeInfo) => {
      if (change.url || change.title || change.status === "complete") void refreshTab();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [refreshTab]);

  useEffect(() => {
    if (!signedInUser || ownTab === null || turnedOff || !BrowserControl.available()) return;
    const c = new BrowserControl({
      tabId: ownTab,
      getToken: async () => {
        const { data } = await supabase().auth.getSession();
        return data.session?.access_token ?? null;
      },
      onChange: setControl,
    });
    controlRef.current = c;
    void c.start();
    const onHide = () => void c.stop();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      if (controlRef.current === c) controlRef.current = null;
      void c.stop();
      setControl({ working: false, lines: [], stopped: false });
    };
  }, [signedInUser, ownTab, turnedOff, controlKey]);

  useEffect(() => {
    if (!busy && !workingRunId) void controlRef.current?.runFinished();
  }, [busy, workingRunId]);

  async function requireToken(): Promise<string> {
    const { data } = await supabase().auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setSession(null);
      throw new Error("Your session expired. Sign in again.");
    }
    return token;
  }

  const refreshApprovals = useCallback(async (token: string, forThread: string) => {
    try {
      const all = await fetchApprovals(token);
      if (threadIdRef.current !== forThread) return;
      setApprovals(all.filter((d) => d.thread_id === forThread));
    } catch {
    }
  }, []);

  const refreshThread = useCallback(
    async (forThread: string, runToWatch: string | null) => {
      let token: string;
      try {
        const { data } = await supabase().auth.getSession();
        if (!data.session?.access_token) return;
        token = data.session.access_token;
      } catch {
        return;
      }
      try {
        const h = await fetchHistory(token, forThread);
        if (threadIdRef.current === forThread) setMessages(h.messages);
      } catch {
      }
      await refreshApprovals(token, forThread);
      if (runToWatch) {
        const status = await fetchRunStatus(token, runToWatch);
        if (status && TERMINAL.has(status)) {
          setWorkingRunId((cur) => (cur === runToWatch ? null : cur));
        }
      }
    },
    [refreshApprovals],
  );

  useEffect(() => {
    if (!threadId || busy || !session) return;
    const id = setInterval(() => {
      if (Date.now() - lastActivityRef.current > THREAD_IDLE_POLL_WINDOW_MS) return;
      void refreshThread(threadId, workingRunId);
    }, THREAD_IDLE_POLL_MS);
    return () => clearInterval(id);
  }, [threadId, busy, session, workingRunId, refreshThread]);

  const handleDecided = useCallback(() => {
    lastActivityRef.current = Date.now();
    const t = threadIdRef.current;
    if (t) void refreshThread(t, null);
  }, [refreshThread]);

  async function handleSend(
    text: string,
    opts?: {
      consentKnownCurrent?: boolean;
    },
  ): Promise<void> {
    const body = text.trim();
    if (!body || busy) return;

    setError(null);
    setNotice(null);
    setBusy(true);
    setPending(body);
    setTurnPhase("capturing");
    const seq = turnSeqRef.current + 1;
    turnSeqRef.current = seq;
    setSteps([]);
    progressInFlightRef.current = false;
    lastActivityRef.current = Date.now();

    let outcome: CaptureOutcome;
    try {
      outcome = await captureActiveTab(ownTabRef.current);
    } catch {
      outcome = { kind: "uncapturable" };
    }

    let token: string;
    try {
      token = await requireToken();
    } catch (e) {
      resetTurn();
      setError(describeSendError(e));
      return;
    }

    let screenshot: { imagePath: string; pageContext: ScreenshotPageContext } | undefined;

    if (outcome.kind === "ok") {
      if (!opts?.consentKnownCurrent) {
        setTurnPhase("checking");
        let mustAsk: boolean;
        try {
          mustAsk = (await getConsent(token)).consent_required;
        } catch {
          resetTurn();
          setDraft(body);
          setError("Zavi couldn't check whether it may take a screenshot. Try again.");
          return;
        }
        if (mustAsk) {
          resetTurn();
          setConsentError(null);
          setConsentPrompt({ text: body });
          return;
        }
      }

      setTurnPhase("capturing");
      try {
        const up = await uploadScreenshot(token, outcome.shot.blob);
        screenshot = {
          imagePath: up.image_path,
          pageContext: {
            mode: "screenshot",
            url: outcome.shot.url,
            title: outcome.shot.title,
          },
        };
      } catch (e) {
        resetTurn();
        handleTurnRefusal(e, body);
        return;
      }
    }

    setTurnPhase("thinking");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const sent = await sendChat(token, {
        message: body,
        threadId,
        screenshot,
        panelSessionId: controlRef.current?.currentSessionId ?? null,
      });
      if (!screenshot) setNotice(UNCAPTURABLE_NOTE);
      setThreadId(sent.thread_id);
      lastActivityRef.current = Date.now();

      try {
        setMessages((await fetchHistory(token, sent.thread_id)).messages);
        setPending(null);
      } catch {
      }

      const outcomeAnswer = await awaitAnswer(token, {
        threadId: sent.thread_id,
        runId: sent.run_id,
        userMessageId: sent.user_message_id,
        signal: controller.signal,
        onTick: (tick) => {
          if (tick % RUN_STATUS_EVERY_N_POLLS === 0) {
            void refreshApprovals(token, sent.thread_id);
          }
          const progressDue = tick === 1 || tick % RUN_STATUS_EVERY_N_POLLS === 0;
          if (sent.run_id && progressDue && !progressInFlightRef.current) {
            progressInFlightRef.current = true;
            const mySeq = seq;
            void fetchRunProgress(token, sent.run_id)
              .then((next) => {
                setSteps((previous) =>
                  nextSteps({
                    incoming: next,
                    mySeq,
                    currentSeq: turnSeqRef.current,
                    previous,
                  }),
                );
              })
              .finally(() => {
                progressInFlightRef.current = false;
              });
          }
        },
      });

      if (outcomeAnswer.kind === "answer") {
        setMessages(outcomeAnswer.messages);
        setPending(null);
        await refreshApprovals(token, sent.thread_id);
        if (sent.run_id) {
          const status = await fetchRunStatus(token, sent.run_id);
          if (status && !TERMINAL.has(status)) setWorkingRunId(sent.run_id);
        }
      } else if (outcomeAnswer.kind === "no_reply") {
        await refreshApprovals(token, sent.thread_id);
        setError(
          `The run finished (${outcomeAnswer.status}) without a reply. Try asking again.`,
        );
      } else if (!controller.signal.aborted) {
        setWorkingRunId(sent.run_id);
        setNotice("Still working. The reply will show up here when it lands.");
      }
    } catch (e) {
      handleTurnRefusal(e, body);
    } finally {
      resetTurn();
      abortRef.current = null;
    }
  }

  function handleTurnRefusal(e: unknown, body: string): void {
    if (e instanceof ApiError && e.code === CONSENT_REQUIRED_CODE) {
      setConsentError(null);
      setConsentPrompt({ text: body });
    } else if (e instanceof ApiError && (e.status === 429 || e.code === DAILY_CAP_CODE)) {
      setDraft(body);
      setNotice(DAILY_CAP_NOTE);
    } else if (e instanceof ApiError && e.status === 401) {
      setSession(null);
    } else {
      setDraft(body);
      setError(describeSendError(e));
    }
  }

  function resetTurn(): void {
    setBusy(false);
    setPending(null);
    setTurnPhase(null);
    turnSeqRef.current += 1;
    setSteps([]);
  }

  async function handleConsentAccept(): Promise<void> {
    if (consentBusy) return;
    const queued = consentPrompt?.text ?? null;
    setConsentBusy(true);
    setConsentError(null);
    setChromeDenied(false);

    let granted: boolean;
    try {
      granted = await requestPageAccess();
    } catch {
      granted = false;
    }
    if (!granted) {
      setChromeDenied(true);
      setConsentBusy(false);
      return;
    }

    try {
      const token = await requireToken();
      await grantConsent(token);
      setControlKey((k) => k + 1);
      setTurnedOff(false);
      setClearedCount(null);
      setConsentPrompt(null);
      setFirstRun(false);
      if (queued) await handleSend(queued, { consentKnownCurrent: true });
    } catch (e) {
      setConsentError(
        e instanceof Error ? e.message : "Couldn't turn screenshots on.",
      );
    } finally {
      setConsentBusy(false);
    }
  }

  const handleConsentDecline = useCallback(() => {
    setDraft(consentPrompt?.text ?? liveDraftRef.current ?? null);
    setConsentPrompt(null);
    setConsentError(null);
    setChromeDenied(false);
    const wasFirstRun = firstRun;
    setFirstRun(false);
    if (wasFirstRun) void dismissFirstRun();
  }, [consentPrompt, firstRun]);

  async function handleTurnOffPageReading(): Promise<void> {
    if (turnOffBusy) return;
    setTurnOffBusy(true);
    setTurnOffError(null);
    try {
      const token = await requireToken();
      const reply = await revokeConsent(token);
      setClearedCount(
        typeof reply.runs_cleared === "number" ? reply.runs_cleared : null,
      );
      setTurnedOff(true);
      setError(null);
      setNotice(null);
    } catch {
      setTurnOffError(
        "Zavi couldn't finish turning page reading off. Some screenshots may not be deleted yet. Try again.",
      );
    } finally {
      setTurnOffBusy(false);
    }
  }

  function handleToggleSettings(): void {
    setTurnOffError(null);
    setSettingsOpen((open) => !open);
  }

  const handleCloseSettings = useCallback(() => {
    setTurnOffError(null);
    setSettingsOpen(false);
  }, []);

  const handleDraftRestored = useCallback(() => setDraft(null), []);

  const handleNewThread = useCallback(() => {
    abortRef.current?.abort();
    turnSeqRef.current += 1;
    setSteps([]);
    setSettingsOpen(false);
    setThreadId(null);
    setMessages([]);
    setApprovals([]);
    setWorkingRunId(null);
    setError(null);
    setNotice(null);
    setConsentPrompt(null);
    setConsentError(null);
  }, [setThreadId]);

  const handleSignOut = useCallback(async () => {
    abortRef.current?.abort();
    turnSeqRef.current += 1;
    setSteps([]);
    await signOut();
    setTurnedOff(false);
    setClearedCount(null);
    setTurnOffError(null);
    handleNewThread();
  }, [handleNewThread]);

  if (!authReady) {
    return (
      <div className="zv-root">
        <div className="zv-center zv-muted">Loading...</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="zv-root">
        <SignIn onSignedIn={setSession} />
      </div>
    );
  }

  const phase: TurnPhase | null = turnPhase ?? (workingRunId ? "working" : null);
  const asking = consentPrompt !== null || firstRun;

  return (
    <div className="zv-root">
      {!asking && (
        <Header
          liveTitle={tab?.title ?? null}
          onNewThread={handleNewThread}
          onOpenSettings={handleToggleSettings}
        />
      )}
      {!asking && control.working && (
        <WorkingBar onStop={() => void controlRef.current?.stopTask()} />
      )}
      {asking ? (
        <ConsentScreen
          onAccept={() => void handleConsentAccept()}
          onDecline={handleConsentDecline}
          busy={consentBusy}
          error={consentError}
          denied={chromeDenied}
        />
      ) : settingsOpen ? (
        <SettingsScreen
          onConfirmTurnOff={() => void handleTurnOffPageReading()}
          onClose={handleCloseSettings}
          onSignOut={() => void handleSignOut()}
          busy={turnOffBusy}
          error={turnOffError}
          turnedOff={turnedOff}
          clearedCount={clearedCount}
        />
      ) : (
        <>
          <MessageList
            messages={messages}
            pending={pending}
            phase={phase}
            steps={steps}
            approvals={approvals}
            getToken={requireToken}
            onDecided={handleDecided}
            tabSteps={control}
          />
          {notice && <p className="zv-note zv-notice">{notice}</p>}
          {error && (
            <p className="zv-error" role="alert">
              {error}
            </p>
          )}
          <Composer
            busy={busy}
            onSend={handleSend}
            restore={draft}
            onRestored={handleDraftRestored}
            onTextChange={(t) => {
              liveDraftRef.current = t;
            }}
          />
        </>
      )}
    </div>
  );
}

function describeSendError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "network") {
      return "Couldn't reach Zavi. Check your connection and try again.";
    }
    if (e.status === 401) return "Your session expired. Sign in again.";
    if (e.status === 413) return "That screenshot was too large to send.";
    return e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong.";
}
