import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
} from "@react-native-google-signin/google-signin";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import type { Session } from "@supabase/supabase-js";
import { authStorageKey, supabase } from "../lib/supabase";
import { apiUrl } from "../lib/api";
import { queryClient } from "../lib/queryClient";
import { registerForPush, unregisterPush } from "../lib/push";
import { clearSentVideoFiles } from "../features/agents/sentVideoFiles";
import { resetAnalytics, track } from "../lib/analytics";
import { authAnalyticsEvent } from "../lib/analyticsCore";
import { runAuthAction, signInWithBrowser } from "./oauth";

const USER_STORAGE_PREFIXES = [
  "zavi.draft.",
  "zavi.pins.",
  "zavi.channelSeen.",
  "zavi.sentVideos.",
  "zavi.onboarding.",
  "zavi.activeTenantId",
  "zavi.deviceId",
];

async function clearPersistedUserData(): Promise<void> {
  clearSentVideoFiles();
  const keys = await AsyncStorage.getAllKeys();
  const mine = keys.filter((k) =>
    USER_STORAGE_PREFIXES.some((p) => k.startsWith(p)),
  );
  if (mine.length > 0) {
    await AsyncStorage.multiRemove(mine);
  }
}

const googleWebClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
const googleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
if (googleWebClientId && (Platform.OS !== "ios" || googleIosClientId)) {
  GoogleSignin.configure({
    webClientId: googleWebClientId,
    ...(googleIosClientId ? { iosClientId: googleIosClientId } : {}),
  });
}

type AuthState = {
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  sendEmailCode: (email: string) => Promise<void>;
  verifyEmailCode: (email: string, code: string, type?: "email" | "signup") => Promise<void>;
  resendSignupCode: (email: string) => Promise<void>;
  signUp: (
    email: string,
    password: string,
    firstName: string,
    lastName: string,
  ) => Promise<{ needsConfirmation: boolean; alreadyRegistered?: boolean }>;
  signInWithGoogle: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signInWithGitHub: () => Promise<void>;
  signInWithSlack: () => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

const trackedAuthEvents = new Set<string>();

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const pushRegisteredFor = useRef<string | null>(null);
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid || pushRegisteredFor.current === uid) return;
    pushRegisteredFor.current = uid;
    void registerForPush().catch(() => {});
  }, [session?.user?.id]);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "SIGNED_IN" && s?.user && !trackedAuthEvents.has(s.user.id)) {
        trackedAuthEvents.add(s.user.id);
        const authEvent = authAnalyticsEvent(s.user);
        track(authEvent.event, { method: authEvent.method });
      }
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      loading,
      signIn: (email, password) =>
        runAuthAction(async () => {
          const { error } = await supabase.auth.signInWithPassword({
            email,
            password,
          });
          if (error) throw error;
        }),
      sendEmailCode: async (email) => {
        const res = await fetch(apiUrl("/api/auth/email/send-otp"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim().toLowerCase() }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(body?.error?.message ?? "Couldn't send a code. Try again in a moment.");
        }
      },
      verifyEmailCode: (email, code, type = "email") =>
        runAuthAction(async () => {
          const { data, error } = await supabase.auth.verifyOtp({
            email: email.trim().toLowerCase(),
            token: code.trim(),
            type,
          });
          if (error) throw new Error(error.message);
          if (!data.session) throw new Error("Verification succeeded but no session was created.");
        }),
      resendSignupCode: async (email) => {
        const { error } = await supabase.auth.resend({
          type: "signup",
          email: email.trim().toLowerCase(),
        });
        if (error) throw error;
      },
      signUp: (email, password, firstName, lastName) =>
        runAuthAction(async () => {
          const first_name = firstName.trim();
          const last_name = lastName.trim();
          const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
              data: {
                first_name,
                last_name,
                full_name: `${first_name} ${last_name}`,
              },
            },
          });
          if (error) throw error;
          if (!data.session && data.user && data.user.identities?.length === 0) {
            return { needsConfirmation: false, alreadyRegistered: true };
          }
          return { needsConfirmation: data.session === null };
        }),
      signInWithGoogle: () =>
        runAuthAction(async () => {
          if (!googleWebClientId) {
            throw new Error(
              "EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is not set. Copy .env.example → .env.",
            );
          }
          if (Platform.OS === "ios" && !googleIosClientId) {
            throw new Error(
              "Google sign-in is not set up for this iOS build yet.",
            );
          }
          await GoogleSignin.hasPlayServices({
            showPlayServicesUpdateDialog: true,
          });

          const rawNonce = Platform.OS === "ios" ? Crypto.randomUUID() : undefined;
          const hashedNonce = rawNonce
            ? await Crypto.digestStringAsync(
                Crypto.CryptoDigestAlgorithm.SHA256,
                rawNonce,
              )
            : undefined;

          const response = await GoogleSignin.signIn({ nonce: hashedNonce }).catch((e: unknown) => {
            if (isErrorWithCode(e) && e.code === "10") {
              throw new Error(
                "Google rejected this build. Check the Android OAuth client's package name and SHA-1.",
              );
            }
            throw e;
          });
          if (!isSuccessResponse(response)) return;

          const idToken = response.data.idToken;
          if (!idToken) throw new Error("Google did not return an ID token");

          const { error } = await supabase.auth.signInWithIdToken({
            provider: "google",
            token: idToken,
            nonce: rawNonce,
          });
          if (error) {
            if (error.message.includes("Unacceptable audience")) {
              throw new Error(
                __DEV__
                  ? `Google sign-in is not set up for this app yet. Supabase does not accept the client id ${googleWebClientId}.`
                  : "Google sign-in is not set up for this app yet.",
              );
            }
            throw error;
          }
        }),
      signInWithApple: () =>
        runAuthAction(async () => {
          const rawNonce = Crypto.randomUUID();
          const hashedNonce = await Crypto.digestStringAsync(
            Crypto.CryptoDigestAlgorithm.SHA256,
            rawNonce,
          );

          let credential: AppleAuthentication.AppleAuthenticationCredential;
          try {
            credential = await AppleAuthentication.signInAsync({
              requestedScopes: [
                AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
                AppleAuthentication.AppleAuthenticationScope.EMAIL,
              ],
              nonce: hashedNonce,
            });
          } catch (e) {
            if ((e as { code?: string }).code === "ERR_REQUEST_CANCELED")
              return;
            throw e;
          }

          if (!credential.identityToken) {
            throw new Error("Apple did not return an identity token");
          }

          const { error } = await supabase.auth.signInWithIdToken({
            provider: "apple",
            token: credential.identityToken,
            nonce: rawNonce,
          });
          if (error) throw error;
          const name = [
            credential.fullName?.givenName,
            credential.fullName?.familyName,
          ]
            .filter(Boolean)
            .join(" ");
          if (name) {
            await supabase.auth
              .updateUser({ data: { full_name: name } })
              .catch(() => {});
          }
        }),
      signInWithGitHub: () =>
        runAuthAction(() => signInWithBrowser("github"), true),
      signInWithSlack: () =>
        runAuthAction(() => signInWithBrowser("slack_oidc"), true),
      signOut: async () => {
        await unregisterPush().catch((e) => console.warn("signOut: push", e));
        await GoogleSignin.signOut().catch((e) => console.warn("signOut: google", e));

        const out = await supabase.auth
          .signOut({ scope: "local" })
          .catch((e) => ({ error: e }));
        if (out.error) console.warn("signOut: supabase", out.error);

        await AsyncStorage.removeItem(authStorageKey).catch(() => {});
        setSession(null);

        pushRegisteredFor.current = null;
        queryClient.clear();
        resetAnalytics();
        await clearPersistedUserData().catch((e) => console.warn("signOut: storage", e));
      },
    }),
    [session, loading],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}
