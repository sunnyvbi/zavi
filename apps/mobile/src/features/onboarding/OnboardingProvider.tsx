import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import { useAuth } from "../../auth/AuthProvider";
import { useWorkspace } from "../workspaces/WorkspaceProvider";
import { supabase } from "../../lib/supabase";
import { saveOnboarding } from "./api";
import { newIdempotencyKey } from "../../lib/apiRetry";
import { track, failureReason } from "../../lib/analytics";
import { registerForPush } from "../../lib/push";
import { saveCompanyFacts, type Facts } from "../settings/api";
import { BLANK, GOALS, LIMITS, MAX_COMPETITORS, type OnboardingData } from "./types";

const VERSION = 1;

function draftKey(userId: string): string {
  return `zavi.onboarding.${userId}`;
}

function attemptedKey(userId: string): string {
  return `zavi.onboarding.attempted.${userId}`;
}

function clean(raw: unknown): OnboardingData {
  const d: OnboardingData = { ...BLANK, competitors: [] };
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  d.website = str(r.website, LIMITS.website);
  d.workspace = str(r.workspace, LIMITS.workspace);
  d.description = str(r.description, LIMITS.idea);
  d.audience = str(r.audience, LIMITS.audience);
  d.goal = typeof r.goal === "string" ? r.goal : "";
  d.noSite = r.noSite === true;
  d.notification =
    r.notification === "allowed" || r.notification === "denied" ? r.notification : "later";
  d.competitors = Array.isArray(r.competitors)
    ? r.competitors
        .slice(0, MAX_COMPETITORS)
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c) => ({
          name: str(c.name, LIMITS.competitorName),
          domain: str(c.domain, LIMITS.competitorDomain),
        }))
    : [];
  return d;
}

const PUBLIC_MAIL: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.co.uk",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "live.co.uk",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.jp",
  "yahoo.co.in",
  "ymail.com",
  "rocketmail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "privaterelay.appleid.com",
  "appleid.com",
  "proton.me",
  "protonmail.com",
  "protonmail.ch",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "gmx.at",
  "gmx.ch",
  "web.de",
  "mail.com",
  "zoho.com",
  "zohomail.com",
  "zoho.eu",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "inbox.ru",
  "bk.ru",
  "list.ru",
  "qq.com",
  "foxmail.com",
  "163.com",
  "126.com",
  "yeah.net",
  "sina.com",
  "sohu.com",
  "fastmail.com",
  "fastmail.fm",
  "tutanota.com",
  "tutanota.de",
  "tuta.io",
  "hushmail.com",
  "hey.com",
  "mailfence.com",
  "disroot.org",
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
  "trashmail.com",
  "temp-mail.org",
  "sharklasers.com",
  "getnada.com",
  "dispostable.com",
  "throwawaymail.com",
]);

function isPublicMailbox(domain: string): boolean {
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (PUBLIC_MAIL.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

function emailDomain(email: string | undefined | null): string {
  if (!email) return "";
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  return email.slice(at + 1).trim().toLowerCase();
}

export function websiteFromEmail(email: string | undefined | null): string {
  const domain = emailDomain(email);
  if (!domain || !domain.includes(".") || isPublicMailbox(domain)) return "";
  return `https://${domain}`;
}

type Ctx = {
  data: OnboardingData;
  patch: (fields: Partial<OnboardingData>) => void;
  reset: () => void;
  suggestedWebsite: string;
  ready: boolean;
  status: OnboardedStatus;
  finish: () => Promise<boolean>;
  prewarmFinish: () => void;
  flow: ExtraFlow;
  replaying: boolean;
  adding: boolean;
  startReplay: (prefill: Partial<OnboardingData>) => void;
  startAddWorkspace: () => void;
  cancelFlow: () => void;
  exiting: boolean;
  clearExiting: () => void;
  finishError: string | null;
};

export type ExtraFlow = "replay" | "add" | null;

export function replayFacts(d: OnboardingData): Partial<Facts> {
  const out: Partial<Facts> = {};
  const put = (k: keyof Facts, v: string) => {
    if (v.trim()) out[k] = v.trim();
  };
  if (!d.noSite) put("domain", d.website);
  put("company_name", d.workspace);
  put("what_we_sell", d.description);
  put("who_we_serve", d.audience);
  put("company_goals", GOALS.find((g) => g.id === d.goal)?.title ?? "");
  put(
    "competitors",
    d.competitors
      .map((c) => c.name.trim())
      .filter(Boolean)
      .join(", "),
  );
  return out;
}

export type OnboardedStatus = "loading" | "needed" | "done";

const OnboardingCtx = createContext<Ctx | null>(null);

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const { refresh: refreshWorkspaces } = useWorkspace();
  const userId = session?.user?.id ?? null;
  const email = session?.user?.email ?? null;

  const suggestedWebsite = useMemo(() => websiteFromEmail(email), [email]);

  const [data, setData] = useState<OnboardingData>(BLANK);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<OnboardedStatus>("loading");
  const [flow, setFlow] = useState<ExtraFlow>(null);
  const [exiting, setExiting] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const createdRef = useRef<{ flow: ExtraFlow } | null>(null);
  const requestKey = useRef<string | null>(null);
  const latest = useRef<OnboardingData>(BLANK);
  const prewarmRef = useRef<{ flow: ExtraFlow; promise: Promise<unknown> } | null>(null);

  useEffect(() => {
    let alive = true;
    if (!userId) {
      setData(BLANK);
      latest.current = BLANK;
      setReady(false);
      return;
    }
    setReady(false);
    AsyncStorage.getItem(draftKey(userId))
      .then((raw) => {
        if (!alive) return;
        let next = BLANK;
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as { v?: number; data?: unknown };
            if (parsed.v === VERSION) next = clean(parsed.data);
          } catch {
          }
        }
        const mailbox = emailDomain(email);
        if (mailbox && !suggestedWebsite && next.website === `https://${mailbox}`) {
          next = { ...next, website: "" };
        }
        if (!next.website && !next.noSite && suggestedWebsite) {
          next = { ...next, website: suggestedWebsite };
        }
        latest.current = next;
        setData(next);
        setReady(true);
      })
      .catch(() => {
        if (!alive) return;
        setReady(true);
      });
    return () => {
      alive = false;
    };
  }, [userId, email, suggestedWebsite]);

  useEffect(() => {
    let alive = true;
    if (!userId) {
      setStatus("loading");
      return;
    }
    void (async () => {
      const { data: profile } = await supabase
        .from("profiles")
        .select("active_tenant_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (!alive) return;
      if (profile?.active_tenant_id) {
        setStatus("done");
        return;
      }
      const attempted = await AsyncStorage.getItem(attemptedKey(userId)).catch(() => null);
      if (!alive) return;
      setStatus(attempted === "1" ? "done" : "needed");
    })();
    return () => {
      alive = false;
    };
  }, [userId]);

  const patch = useCallback(
    (fields: Partial<OnboardingData>) => {
      const next = { ...latest.current, ...fields };
      latest.current = next;
      setData(next);
      if (!userId) return;
      void AsyncStorage.setItem(
        draftKey(userId),
        JSON.stringify({ v: VERSION, data: next }),
      ).catch(() => {});
    },
    [userId],
  );

  const reset = useCallback(() => {
    latest.current = BLANK;
    setData(BLANK);
    if (userId) void AsyncStorage.removeItem(draftKey(userId)).catch(() => {});
  }, [userId]);

  const begin = useCallback((kind: Exclude<ExtraFlow, null>, next: OnboardingData) => {
    latest.current = next;
    setData(next);
    setFinishError(null);
    createdRef.current = null;
    requestKey.current = null;
    setExiting(false);
    setFlow(kind);
  }, []);

  const startReplay = useCallback(
    (prefill: Partial<OnboardingData>) => begin("replay", { ...BLANK, competitors: [], ...prefill }),
    [begin],
  );

  const startAddWorkspace = useCallback(
    () => begin("add", { ...BLANK, competitors: [], website: suggestedWebsite }),
    [begin, suggestedWebsite],
  );

  const cancelFlow = useCallback(() => {
    if (flow) setExiting(true);
    setFlow(null);
    setFinishError(null);
    createdRef.current = null;
    requestKey.current = null;
    latest.current = BLANK;
    setData(BLANK);
    if (userId) void AsyncStorage.removeItem(draftKey(userId)).catch(() => {});
  }, [userId, flow]);

  const clearExiting = useCallback(() => setExiting(false), []);

  useEffect(() => {
    if (!userId) {
      setFlow(null);
      setExiting(false);
      prewarmRef.current = null;
    }
  }, [userId]);

  const prewarmFinish = useCallback(() => {
    if (!userId || flow !== "replay" || prewarmRef.current) return;
    const promise = saveCompanyFacts(replayFacts(latest.current));
    promise.catch(() => {});
    prewarmRef.current = { flow, promise };
  }, [userId, flow]);

  const createWorkspace = useCallback(async (): Promise<boolean> => {
    if (!userId) return false;
    if (flow === "replay") return true;
    if (createdRef.current?.flow === flow) return true;
    setFinishError(null);
    const path = latest.current.noSite ? "idea" : "website";
    const addCompany = flow === "add";
    track("onboarding_commit_started", { path, add_company: addCompany });
    if (flow === "add") {
      let tenantId: string | null = null;
      try {
        tenantId = await saveOnboarding(latest.current, true, (requestKey.current ??= newIdempotencyKey()));
      } catch (e) {
        track("onboarding_commit_failed", { path, reason: failureReason(e) });
        setFinishError((e as Error).message || null);
        return false;
      }
      if (!tenantId || !(await refreshWorkspaces(tenantId))) {
        track("onboarding_commit_failed", { path, reason: "server" });
        return false;
      }
    } else {
      let error: unknown = null;
      try {
        await saveOnboarding(latest.current, false, (requestKey.current ??= newIdempotencyKey()));
      } catch (e) {
        error = e;
      }
      if (!(await refreshWorkspaces())) {
        track("onboarding_commit_failed", { path, reason: failureReason(error) });
        return false;
      }
    }
    track("onboarding_completed", { path, outcome: "created", add_company: addCompany });
    if (latest.current.notification === "allowed") void registerForPush().catch(() => {});
    createdRef.current = { flow };
    requestKey.current = null;
    return true;
  }, [userId, flow, refreshWorkspaces]);

  const finishing = useRef<Promise<boolean> | null>(null);
  const finishOnce = useCallback(async (): Promise<boolean> => {
    if (!userId) return false;
    setFinishError(null);
    if (flow === "replay") {
      const prewarm = prewarmRef.current?.flow === flow ? prewarmRef.current.promise : null;
      prewarmRef.current = null;
      try {
        await (prewarm ?? saveCompanyFacts(replayFacts(latest.current)));
      } catch (e) {
        setFinishError((e as Error).message || null);
        return false;
      }
      cancelFlow();
      router.dismissTo("/settings");
      return true;
    }
    if (!(await createWorkspace())) return false;
    createdRef.current = null;
    if (flow === "add") {
      cancelFlow();
      router.dismissTo("/chat");
      return true;
    }
    await AsyncStorage.setItem(attemptedKey(userId), "1").catch(() => {});
    setStatus("done");
    await AsyncStorage.removeItem(draftKey(userId)).catch(() => {});
    return true;
  }, [userId, flow, cancelFlow, createWorkspace]);

  const finish = useCallback((): Promise<boolean> => {
    if (finishing.current) return finishing.current;
    const p = finishOnce().finally(() => {
      finishing.current = null;
    });
    finishing.current = p;
    return p;
  }, [finishOnce]);

  const value = useMemo<Ctx>(
    () => ({
      data,
      patch,
      reset,
      suggestedWebsite,
      ready,
      status,
      finish,
      prewarmFinish,
      flow,
      replaying: flow === "replay",
      adding: flow === "add",
      startReplay,
      startAddWorkspace,
      cancelFlow,
      exiting,
      clearExiting,
      finishError,
    }),
    [
      data,
      patch,
      reset,
      suggestedWebsite,
      ready,
      status,
      finish,
      prewarmFinish,
      flow,
      startReplay,
      startAddWorkspace,
      cancelFlow,
      exiting,
      clearExiting,
      finishError,
    ],
  );

  return <OnboardingCtx.Provider value={value}>{children}</OnboardingCtx.Provider>;
}

export function useOnboarding(): Ctx {
  const ctx = useContext(OnboardingCtx);
  if (!ctx) throw new Error("useOnboarding must be used inside OnboardingProvider");
  return ctx;
}

