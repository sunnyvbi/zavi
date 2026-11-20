import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import { authStorageKey, supabase } from "../lib/supabase";

export type BrowserOAuthProvider = "github" | "slack_oidc";
type OAuthCallbackParams = {
  attempt?: string | string[];
  code?: string | string[];
  error?: string | string[];
  error_code?: string | string[];
  error_description?: string | string[];
};

export const OAUTH_REDIRECT_URL = "zavi://auth/callback";
const PENDING_KEY = "zavi.auth.pendingOAuth";
const VERIFIER_KEY = `${authStorageKey}-code-verifier`;
const ATTEMPT_MAX_AGE_MS = 10 * 60 * 1000;

const runtime = {
  authenticating: false,
  launching: false,
  exchanging: false,
  completion: null as {
    key: string;
    attemptId: string;
    promise: Promise<void>;
  } | null,
};

export async function runAuthAction<T>(
  action: () => Promise<T>,
  browser = false,
): Promise<T> {
  if (runtime.authenticating || runtime.launching || runtime.exchanging) {
    throw new Error("Another sign-in is already in progress.");
  }
  runtime.authenticating = true;
  try {
    if (!browser) {
      runtime.completion = null;
      await AsyncStorage.multiRemove([PENDING_KEY, VERIFIER_KEY]);
    }
    return await action();
  } finally {
    runtime.authenticating = false;
  }
}

function currentCompletion() {
  return runtime.completion;
}

async function clearAttempt(attemptId: string) {
  const stored = await AsyncStorage.getItem(PENDING_KEY);
  if (stored && JSON.parse(stored).attemptId === attemptId) {
    await AsyncStorage.multiRemove([PENDING_KEY, VERIFIER_KEY]);
  }
}

function callbackParams(url: string): OAuthCallbackParams {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "zavi:" ||
    parsed.host !== "auth" ||
    parsed.pathname !== "/callback" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error("Invalid sign-in response. Please try again.");
  }
  const params: OAuthCallbackParams = {};
  for (const name of [
    "attempt",
    "code",
    "error",
    "error_code",
    "error_description",
  ] as const) {
    const values = parsed.searchParams.getAll(name);
    if (values.length) params[name] = values.length === 1 ? values[0] : values;
  }
  return params;
}

async function exchangeCallback(params: OAuthCallbackParams): Promise<void> {
  let ownsAttempt = false;
  try {
    const stored = await AsyncStorage.getItem(PENDING_KEY);
    const pending = stored ? JSON.parse(stored) : null;
    if (!pending || pending.attemptId !== params.attempt) {
      throw new Error("This sign-in has expired. Please start again.");
    }
    ownsAttempt = true;
    if (
      !["github", "slack_oidc"].includes(pending.provider) ||
      typeof pending.startedAt !== "number" ||
      !Number.isFinite(pending.startedAt) ||
      Date.now() - pending.startedAt > ATTEMPT_MAX_AGE_MS ||
      Date.now() < pending.startedAt
    ) {
      throw new Error("This sign-in has expired. Please start again.");
    }
    if (params.error || params.error_code || params.error_description) {
      throw new Error("Sign-in was not completed. Please try again.");
    }
    if (typeof params.code !== "string" || !params.code.trim()) {
      throw new Error("No sign-in code was returned. Please try again.");
    }
    const { data, error } = await supabase.auth.exchangeCodeForSession(
      params.code,
    );
    if (error || !data.session) {
      throw new Error("Unable to finish signing in. Please start again.");
    }
  } finally {
    if (ownsAttempt)
      await clearAttempt(params.attempt as string).catch(() => {});
  }
}

export function completeBrowserOAuth(url: string): Promise<void> {
  let params: OAuthCallbackParams;
  try {
    params = callbackParams(url);
  } catch {
    return Promise.reject(
      new Error("Invalid sign-in response. Please try again."),
    );
  }
  if (runtime.authenticating && !runtime.launching) {
    return Promise.reject(new Error("Another sign-in is already in progress."));
  }
  if (typeof params.attempt !== "string" || !params.attempt) {
    return Promise.reject(
      new Error("This sign-in has expired. Please start again."),
    );
  }
  const key = JSON.stringify([
    params.attempt,
    params.code,
    params.error,
    params.error_code,
    params.error_description,
  ]);
  if (runtime.completion?.key === key) return runtime.completion.promise;
  if (runtime.exchanging) {
    return Promise.reject(new Error("Another sign-in is already finishing."));
  }
  runtime.exchanging = true;
  const promise = exchangeCallback(params).finally(() => {
    runtime.exchanging = false;
  });
  runtime.completion = { key, attemptId: params.attempt, promise };
  return promise;
}

export async function signInWithBrowser(
  provider: BrowserOAuthProvider,
): Promise<void> {
  if (runtime.launching || runtime.exchanging) {
    throw new Error("Another sign-in is already in progress.");
  }
  runtime.launching = true;
  runtime.completion = null;
  let attemptId: string | null = null;
  try {
    attemptId = Crypto.randomUUID();
    const redirectTo = `${OAUTH_REDIRECT_URL}?attempt=${encodeURIComponent(attemptId)}`;
    await AsyncStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ attemptId, provider, startedAt: Date.now() }),
    );
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error || !data.url) {
      throw new Error("Unable to start sign-in. Please try again.");
    }

    const bytes = Crypto.getRandomValues(new Uint8Array(32));
    const verifier = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const digest = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      verifier,
      {
        encoding: Crypto.CryptoEncoding.BASE64,
      },
    );
    const url = new URL(data.url);
    url.searchParams.set(
      "code_challenge",
      digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    );
    url.searchParams.set("code_challenge_method", "s256");
    await AsyncStorage.setItem(VERIFIER_KEY, JSON.stringify(verifier));

    const result = await WebBrowser.openAuthSessionAsync(
      url.toString(),
      OAUTH_REDIRECT_URL,
    );
    if (result.type === "success") {
      await completeBrowserOAuth(result.url);
    } else {
      if (Platform.OS === "android" && result.type === "dismiss") {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const pendingCompletion = currentCompletion();
      if (pendingCompletion?.attemptId === attemptId) {
        await pendingCompletion.promise;
      } else if (result.type !== "cancel" && result.type !== "dismiss") {
        throw new Error("Unable to open sign-in. Please try again.");
      }
    }
  } finally {
    if (attemptId) await clearAttempt(attemptId).catch(() => {});
    runtime.launching = false;
  }
}
