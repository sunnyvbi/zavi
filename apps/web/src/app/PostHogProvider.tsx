"use client";

import { Suspense, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import posthog from "posthog-js";
import { PostHogProvider as PHProvider, usePostHog } from "posthog-js/react";
import { allowsAnalytics, hasAnalyticsConsent, subscribe } from "@/lib/consent";
import { createBrowserSupabase } from "@/lib/supabase";
import { getVerifiedUser } from "@/lib/verifiedUser";
import { identifyUser, resetAnalytics } from "@/lib/analytics/posthog";
import { appPageInfo, pageInfo } from "@/lib/analytics/pages";
import { tabUrlParam, urlTabKindFromParam } from "@/lib/workspace/tabUrl";
import { analyticsUrl, scrubUrlProps } from "@/lib/analytics/url";

const POSTHOG_PROXY_PATH = "/r-Hg5x3K";

const TEXT_ATTRIBUTES = new Set([
  "title", "alt", "placeholder", "value", "label", "content", "download", "srcdoc", "href",
  "id", "for", "name",
]);
const EMAIL = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi;
const URL_SECRET = /([?&#](?:token|access_token|refresh_token|id_token|invite|code|start|startgroup|text|body|sig|signature|secret|zavi_confirmation|api_key|apikey|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&#\s"'<>]+/gi;
const KEY_SHAPED = /\b(?:zavi_pat_|praxis_pat_|zpair_|sk_live_|sk_test_|rk_live_|rk_test_|whsec_|ghp_|gho_|github_pat_|xox[abposr]-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const SECRET_AUTOCOMPLETE = /password|one-time-code|email|cc-/;
const MASKED_AREA = "[data-replay-mask], .ph-mask";

const hide = (value: string) => "*".repeat(value.length);
const hideSecrets = (value: string) =>
  value
    .replace(EMAIL, hide)
    .replace(KEY_SHAPED, hide)
    .replace(URL_SECRET, (match: string, key: string) => key + hide(match.slice(key.length)));
const inMaskedArea = (element?: Element | null) => !!element?.closest?.(MASKED_AREA);

function isSecretField(element?: Element | null): boolean {
  if (!element) return false;
  const type = (element.getAttribute("type") ?? "").toLowerCase();
  const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
  return type === "password" || type === "email" || SECRET_AUTOCOMPLETE.test(autocomplete);
}

export function maskReplayText(text: string, element?: HTMLElement): string {
  return inMaskedArea(element) ? hide(text) : hideSecrets(text);
}

export function maskReplayInput(text: string, element?: HTMLElement): string {
  return isSecretField(element) || inMaskedArea(element) || text.includes("@") || hideSecrets(text) !== text
    ? hide(text)
    : text;
}

export function maskReplayAttribute(name: string, value: string, element?: Element): string {
  const n = name.toLowerCase();
  if (n === "href" && element?.tagName === "LINK") return value;
  if (n === "value" && (isSecretField(element) || value.includes("@"))) return hide(value);
  if (inMaskedArea(element) && (TEXT_ATTRIBUTES.has(n) || n.startsWith("aria-") || n.startsWith("data-"))) {
    return hide(value);
  }
  return hideSecrets(value);
}

function isLoaded(): boolean {
  return (posthog as unknown as { __loaded?: boolean }).__loaded === true;
}

function PostHogPageView({ ready }: { ready: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const ph = usePostHog();

  useEffect(() => {
    if (!ph || !ready || !pathname) return;
    const info = pageInfo(pathname) ?? appPageInfo(pathname);
    if (!info) return;

    const qs = searchParams?.toString();
    const app = info.group === "app";
    const url = analyticsUrl(`${window.origin}${app ? "/workspace" : pathname}${qs ? `?${qs}` : ""}`);
    const kind = app ? urlTabKindFromParam(searchParams?.get("tab")) : null;
    const tab = kind ? tabUrlParam(kind) : null;

    try {
      const key = `ph_pv:${url}` + (tab ? `#${tab}` : "");
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
    }

    ph.capture("$pageview", {
      $current_url: url,
      page_type: info.type,
      page_group: info.group,
      ...(app ? { $pathname: "/workspace" } : {}),
      ...(tab ? { workspace_tab: tab } : {}),
    });
  }, [pathname, searchParams, ph, ready]);

  return null;
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = window.location.hostname;
    const isLocalhost =
      host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost");
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

    let withdrawn = false;

    let authSub: { unsubscribe: () => void } | null = null;
    let authEpoch = 0;
    const watchIdentity = () => {
      const supabase = createBrowserSupabase();
      const epoch = authEpoch;
      void getVerifiedUser(supabase).then((user) => {
        if (user && epoch === authEpoch && !withdrawn) {
          identifyUser(user.id, { email: user.email });
        }
      });
      authSub = supabase.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_IN" || event === "SIGNED_OUT") authEpoch++;
        if (withdrawn) return;
        if (event === "SIGNED_IN" && session?.user) {
          identifyUser(session.user.id, { email: session.user.email });
        } else if (event === "SIGNED_OUT") {
          resetAnalytics();
        }
      }).data.subscription;
    };

    const init = (allowed: boolean) => {
      if (isLocalhost) return;
      if (!allowed) return;
      if (isLoaded()) {
        if (withdrawn) window.location.reload();
        return;
      }
      if (!key || key === "undefined") {
        console.warn("[PostHog] NEXT_PUBLIC_POSTHOG_KEY is not set; analytics disabled.");
        return;
      }

      posthog.init(key, {
        api_host: POSTHOG_PROXY_PATH,
        ui_host: "https://us.posthog.com",
        person_profiles: "identified_only",
        capture_pageview: false,
        autocapture: false,
        capture_performance: false,
        session_recording: {
          maskAllInputs: true,
          maskInputFn: maskReplayInput,
          maskTextSelector: "*",
          maskTextFn: maskReplayText,
          maskAttributeFn: maskReplayAttribute,
          blockSelector: "img, video, canvas, picture, svg image",
          maskCapturedNetworkRequestFn: () => null,
        },
        enable_recording_console_log: false,
        before_send: (event) =>
          event && {
            ...event,
            properties: scrubUrlProps(event.properties),
            $set: scrubUrlProps(event.$set),
            $set_once: scrubUrlProps(event.$set_once),
          },
        opt_out_capturing_by_default: true,
        loaded: (ph) => {
          if (!ph.has_opted_in_capturing()) ph.opt_in_capturing();
          setReady(true);
          watchIdentity();
        },
      });
    };

    init(hasAnalyticsConsent());
    const unsubscribe = subscribe((state) => {
      if (allowsAnalytics(state)) init(true);
      else if (isLoaded()) {
        posthog.set_config({ disable_persistence: true });
        posthog.stopSessionRecording();
        posthog.opt_out_capturing();
        withdrawn = true;
        setReady(false);
      }
    });
    return () => {
      unsubscribe();
      authSub?.unsubscribe();
    };
  }, []);

  return (
    <PHProvider client={posthog}>
      <Suspense fallback={null}>
        <PostHogPageView ready={ready} />
      </Suspense>
      {children}
    </PHProvider>
  );
}
