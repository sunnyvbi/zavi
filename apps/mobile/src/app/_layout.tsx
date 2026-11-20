import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRootNavigationState, useRouter, useSegments, type ErrorBoundaryProps } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { QueryClientProvider } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { Inter_400Regular } from "@expo-google-fonts/inter/400Regular";
import { Inter_500Medium } from "@expo-google-fonts/inter/500Medium";
import { Inter_600SemiBold } from "@expo-google-fonts/inter/600SemiBold";
import { Inter_700Bold } from "@expo-google-fonts/inter/700Bold";
import { PlusJakartaSans_400Regular } from "@expo-google-fonts/plus-jakarta-sans/400Regular";
import { PlusJakartaSans_500Medium } from "@expo-google-fonts/plus-jakarta-sans/500Medium";
import { PlusJakartaSans_600SemiBold } from "@expo-google-fonts/plus-jakarta-sans/600SemiBold";
import { PlusJakartaSans_700Bold } from "@expo-google-fonts/plus-jakarta-sans/700Bold";
import { PlusJakartaSans_800ExtraBold } from "@expo-google-fonts/plus-jakarta-sans/800ExtraBold";
import { queryClient, startFocusManager } from "../lib/queryClient";
import { popBackTo, resetTo } from "../lib/nav";
import { MotionProvider } from "../lib/motion";
import { AppearanceProvider } from "../lib/appearance";
import { AuthProvider, useAuth } from "../auth/AuthProvider";
import { WorkspaceProvider, useWorkspace } from "../features/workspaces/WorkspaceProvider";
import { useAgents } from "../features/agents/hooks";
import { LoadingScreen } from "../components/LoadingScreen";
import { CrashScreen } from "../components/CrashScreen";
import { DialogHost } from "../components/DialogHost";
import { TenantDisabledWatcher } from "../components/TenantDisabledWatcher";
import { OnboardingProvider, useOnboarding } from "../features/onboarding/OnboardingProvider";
import { useCreatorProbe } from "../features/creator/hooks";
import { getPendingInvite } from "../features/invites/pendingInvite";
import { appPhase, gatePhase, PHASE_ROUTE } from "../features/creator/phase";
import { AiConsentProvider } from "../features/consent/AiConsentProvider";
import { useAiConsent } from "../features/consent/useAiConsent";
import { SetupProvider, useSetup } from "../features/setup/SetupProvider";
import { staysDuringSetup } from "../features/setup/state";
import { useTheme, type Theme } from "../theme/theme";
import { initNotifications } from "../lib/push";
import { pushTarget, type PushData } from "../lib/pushRoute";
import { reportError, setCrashUser } from "../lib/crash";
import { identifyUser, screenFromSegments, trackScreen } from "../lib/analytics";

initNotifications();

void SplashScreen.preventAutoHideAsync().catch(() => {});
const SPLASH_MAX_MS = 10000;

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => {
    reportError(error);
    void SplashScreen.hideAsync();
  }, [error]);
  return <CrashScreen onRetry={() => void retry()} />;
}

export default function RootLayout() {
  useEffect(() => {
    startFocusManager();
  }, []);

  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  });

  return <AppearanceProvider>{fontsLoaded ? <AppFrame /> : null}</AppearanceProvider>;
}

function AppFrame() {
  const { dark } = useTheme();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {}
      <StatusBar style={dark ? "light" : "dark"} />
      <SafeAreaProvider>
        <MotionProvider>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <AiConsentProvider>
                <WorkspaceProvider>
                  <SetupProvider>
                    <OnboardingProvider>
                      <BottomSheetModalProvider>
                        <RootNav />
                        <DialogHost />
                        <TenantDisabledWatcher />
                      </BottomSheetModalProvider>
                    </OnboardingProvider>
                  </SetupProvider>
                </WorkspaceProvider>
              </AiConsentProvider>
            </AuthProvider>
          </QueryClientProvider>
        </MotionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const navThemes = new Map<Theme, ReturnType<typeof navThemeFor>>();
function navThemeFor(theme: Theme) {
  const base = theme.dark ? DarkTheme : DefaultTheme;
  const c = theme.colors;
  return {
    ...base,
    colors: { ...base.colors, primary: c.ink, background: c.bg, card: c.bg, text: c.ink, border: c.line, notification: c.red },
  };
}
function navTheme(theme: Theme) {
  let t = navThemes.get(theme);
  if (!t) {
    t = navThemeFor(theme);
    navThemes.set(theme, t);
  }
  return t;
}

function RootNav() {
  const theme = useTheme();
  const { colors } = theme;
  const { session, loading } = useAuth();
  const { status, flow, exiting, clearExiting } = useOnboarding();
  const creator = useCreatorProbe();
  const consent = useAiConsent();
  const setup = useSetup();
  const buildOpen = setup.state?.enabled === true && setup.state.build_open === true;
  const agents = useAgents();
  const { switching } = useWorkspace();
  const [afterSwitch, setAfterSwitch] = useState(false);
  useEffect(() => {
    if (switching) setAfterSwitch(true);
    else if (afterSwitch && !agents.isPending) setAfterSwitch(false);
  }, [switching, afterSwitch, agents.isPending]);
  const segments = useSegments();
  const router = useRouter();
  const navReady = !!useRootNavigationState()?.key;
  const landedOn = useRef(new Set<string>());

  const userId = session?.user?.id ?? null;
  useEffect(() => {
    setCrashUser(userId);
  }, [userId]);
  useEffect(() => {
    if (session?.user?.id) identifyUser(session.user.id, session.user.email);
  }, [session?.user?.id, session?.user?.email]);
  const lastScreen = useRef<string | null>(null);
  useEffect(() => {
    if (segments.length === 0) return;
    const screen = screenFromSegments([...segments]);
    if (lastScreen.current === screen.screen_name) return;
    lastScreen.current = screen.screen_name;
    trackScreen(screen.screen_name, { screen_group: screen.screen_group });
  }, [segments]);

  const phaseNow = gatePhase({
    phase: appPhase({ signedIn: !!session, onboarding: status, creator }),
    consent: consent.status,
    setup: setup.gate,
  });
  const startupPhase = phaseNow;
  const startupDone =
    !loading &&
    startupPhase !== "wait" &&
    segments.length > 0 &&
    (startupPhase !== "chat" || !agents.isPending);
  useEffect(() => {
    if (startupDone) void SplashScreen.hideAsync();
  }, [startupDone]);
  useEffect(() => {
    const t = setTimeout(() => void SplashScreen.hideAsync(), SPLASH_MAX_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (loading || !navReady) return;
    const inAuth = segments[0] === "(auth)";
    const inOnboarding = segments[0] === "(onboarding)";
    const inCreator = segments[0] === "creator";
    const inConsent = segments[0] === "consent";
    const inSetup = segments[0] === "growth-setup";
    if (segments[0] === "invite" || segments[0] === "reset-password" || segments[0] === "connectors") return;
    const phase = phaseNow;
    if (phase !== "consent" && phase !== "setup") landedOn.current.clear();
    if (inConsent) landedOn.current.add(PHASE_ROUTE.consent);
    if (inSetup) landedOn.current.add(PHASE_ROUTE.setup);
    const bounceTo = (route: "/consent" | "/growth-setup") => {
      if (landedOn.current.delete(route)) {
        popBackTo(route);
        return;
      }
      resetTo(route);
    };

    if (phase === "wait") return;
    if (phase === "auth") {
      if (!inAuth) resetTo(PHASE_ROUTE.auth);
      return;
    }
    if (phase === "consent") {
      if (!inConsent) bounceTo(PHASE_ROUTE.consent);
      return;
    }
    if (phase === "onboarding") {
      if (!inOnboarding) resetTo(PHASE_ROUTE.onboarding);
      return;
    }
    if (phase === "creator") {
      if (!inCreator) resetTo(PHASE_ROUTE.creator);
      return;
    }
    if (inOnboarding && (flow || exiting)) return;
    if (exiting) clearExiting();
    if (phase === "setup") {
      if (!staysDuringSetup(segments[0], buildOpen)) bounceTo(PHASE_ROUTE.setup);
      return;
    }
    if (inAuth || inOnboarding || inCreator || inConsent || inSetup) {
      resetTo(PHASE_ROUTE.chat);
    }
  }, [loading, navReady, phaseNow, buildOpen, segments, router, flow, exiting, clearExiting]);

  useEffect(() => {
    if (loading || !navReady || !session || segments[0] === "invite" || segments[0] === "reset-password") return;
    let cancelled = false;
    void getPendingInvite().then((id) => {
      if (!cancelled && id) router.replace({ pathname: "/invite/accept", params: { id } });
    });
    return () => {
      cancelled = true;
    };
  }, [loading, navReady, session, segments, router]);

  const [lastResponse, setLastResponse] = useState<Notifications.NotificationResponse | null>(null);
  useEffect(() => {
    if (Platform.OS === "web") return;
    setLastResponse(Notifications.getLastNotificationResponse());
    const sub = Notifications.addNotificationResponseReceivedListener(setLastResponse);
    return () => sub.remove();
  }, []);
  const handledResponse = useRef<string | null>(null);
  const readyForChat = !loading && navReady && phaseNow === "chat";

  useEffect(() => {
    if (Platform.OS === "web") return;
    void Notifications.setBadgeCountAsync(0).catch(() => {});
  }, []);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const sub = Notifications.addNotificationReceivedListener(() => {
      void queryClient.invalidateQueries({ queryKey: ["status-counters"] });
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      void queryClient.invalidateQueries({ queryKey: ["chat-history"] });
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (Platform.OS === "web" || !readyForChat || !lastResponse) return;
    if (lastResponse.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = lastResponse.notification.request.identifier;
    if (handledResponse.current === id) return;
    handledResponse.current = id;
    Notifications.clearLastNotificationResponse();
    router.push(pushTarget(lastResponse.notification.request.content.data as PushData));
  }, [lastResponse, readyForChat, router]);

  if (loading) return null;

  return (
    <>
    <ThemeProvider value={navTheme(theme)}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="(auth)/welcome" />
        <Stack.Screen name="(auth)/login" />
        <Stack.Screen name="(auth)/email-code" />
        <Stack.Screen name="(auth)/signup" />
        <Stack.Screen name="consent" options={{ gestureEnabled: false }} />
        <Stack.Screen name="(onboarding)/website" />
        <Stack.Screen name="(onboarding)/scanning" />
        <Stack.Screen name="(onboarding)/business" />
        <Stack.Screen name="(onboarding)/idea" />
        <Stack.Screen name="(onboarding)/priority" />
        <Stack.Screen name="(onboarding)/competitors" />
        <Stack.Screen name="(onboarding)/setup" options={{ gestureEnabled: false }} />
        <Stack.Screen name="(onboarding)/notifications" />
        <Stack.Screen name="growth-setup" options={{ gestureEnabled: false }} />
        <Stack.Screen name="chat" />
        <Stack.Screen name="invite/accept" />
        <Stack.Screen name="reset-password" />
        <Stack.Screen name="connectors/done" options={{ animation: "none", presentation: "transparentModal" }} />
        <Stack.Screen name="connectors/finish" options={{ animation: "none", presentation: "transparentModal" }} />
        <Stack.Screen name="artifacts" />
        <Stack.Screen name="search" />
        <Stack.Screen name="channels/index" />
        <Stack.Screen name="channels/actions/[slug]" />
        <Stack.Screen name="channels/[id]" />
        <Stack.Screen name="channels/ugc/find" />
        <Stack.Screen name="channels/ugc/inbox" />
        <Stack.Screen name="channels/ugc/notices" />
        <Stack.Screen name="channels/ugc/creator/[id]" />
        <Stack.Screen name="channels/ugc/thread/[id]" />
        <Stack.Screen name="channels/ugc/job/[id]" />
        <Stack.Screen name="channels/ugc/brief/[id]" />
        <Stack.Screen name="channels/ugc/briefs" />
        <Stack.Screen name="channels/ugc/applicants/[id]" />
        <Stack.Screen name="channels/ugc/hire" />
        <Stack.Screen name="channels/ugc/jobs" />
        <Stack.Screen name="channels/ugc/library" />
        <Stack.Screen name="growth" />
        <Stack.Screen name="growth-review" />
        <Stack.Screen name="analytics/index" />
        <Stack.Screen name="analytics/[source]" />
        <Stack.Screen name="messaging" />
        <Stack.Screen name="build/index" />
        <Stack.Screen name="build/new" />
        <Stack.Screen name="build/templates" />
        <Stack.Screen name="build/theme" />
        <Stack.Screen name="build/[id]" />
        <Stack.Screen name="toolkit/index" />
        <Stack.Screen name="agents/index" />
        <Stack.Screen name="agents/[id]" />
        <Stack.Screen name="agents/results" />
        <Stack.Screen name="skill/[id]" />
        {}
        <Stack.Screen name="creator/index" />
        <Stack.Screen name="creator/briefs" />
        <Stack.Screen name="creator/jobs/index" />
        <Stack.Screen name="creator/jobs/[orderId]" />
        <Stack.Screen name="creator/earnings" />
        <Stack.Screen name="creator/storefront" />
        <Stack.Screen name="settings/index" />
        <Stack.Screen name="delete-account" />
        <Stack.Screen name="settings/account" />
        <Stack.Screen name="settings/name" />
        <Stack.Screen name="settings/password" />
        <Stack.Screen name="settings/channel-notifications" />
        <Stack.Screen name="settings/company" />
        <Stack.Screen name="settings/team" />
        <Stack.Screen name="settings/rules" />
        <Stack.Screen name="settings/appearance" />
        <Stack.Screen name="settings/feedback" />
        <Stack.Screen name="settings/invite" />
        <Stack.Screen name="settings/billing" />
        <Stack.Screen name="settings/mcp" />
      </Stack>
    </ThemeProvider>
    {afterSwitch && segments[0] !== "settings" ? (
      <View style={StyleSheet.absoluteFill}>
        <LoadingScreen label="Switching workspace…" />
      </View>
    ) : null}
    </>
  );
}
