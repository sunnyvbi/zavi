import { useEffect, useRef, useState } from "react";
import { friendlyError } from "../../components/ErrorCard";
import {
  Animated,
  Easing,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useAuth } from "../../auth/AuthProvider";
import { isEmailSignupEnabled, useSignupAvailability } from "../../auth/signup";
import { BrowserSignInButton } from "../../components/BrowserSignInButton";
import type { BrowserOAuthProvider } from "../../auth/oauth";
import { AppleMark } from "../../components/AppleMark";
import { useAppleSignInAvailable } from "../../components/useAppleSignIn";
import { font, palettes, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { useReduceMotion } from "../../lib/motion";
import { track } from "../../lib/analytics";

const dock = {
  bg: palettes.dark.surfaceRaised,
  emailBg: "#2b2b2d",
  loginBorder: palettes.dark.borderRaised,
  onDark: "#ffffff",
  googleFg: "#111111",
  errorBg: "#2a1b1a",
  errorBorder: "#5c322e",
  errorFg: "#ffb4ad",
} as const;

const WORDS = [
  "run your business",
  "grow your business",
  "build your business",
] as const;
const TYPE_MS = 55;
const DELETE_MS = 28;
const HOLD_MS = 1400;
const GAP_MS = 260;
const BREATHE_MS = 1000;

const REF_SIZE = 34;
const REF_LINE = 39;
const REF_DOT = 23;
const REF_WIDTH = 326;
const SIDE_PADDING = 27;
const MIN_SIZE = 22;
const SAFETY_DP = 4;

export default function Welcome() {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const {
    signInWithGoogle,
    signInWithApple,
    signInWithGitHub,
    signInWithSlack,
  } = useAuth();
  const signupAvailability = useSignupAvailability();

  const fitScale = Math.min(
    1,
    (width - SIDE_PADDING * 2 - SAFETY_DP) / REF_WIDTH,
  );
  const headlineSize = Math.max(MIN_SIZE, Math.floor(REF_SIZE * fitScale));
  const lineHeight = Math.round(headlineSize * (REF_LINE / REF_SIZE));
  const dotSize = Math.round(headlineSize * (REF_DOT / REF_SIZE));

  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [wordIndex, setWordIndex] = useState(0);
  const reduceMotion = useReduceMotion();
  const [googleBusy, setGoogleBusy] = useState(false);
  const [appleBusy, setAppleBusy] = useState(false);
  const [browserBusy, setBrowserBusy] = useState<BrowserOAuthProvider | null>(
    null,
  );
  const appleAvailable = useAppleSignInAvailable();
  const [error, setError] = useState<string | null>(null);

  const requestInFlight = useRef(false);

  const busy = googleBusy || appleBusy || browserBusy !== null;

  const breathe = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    track("auth_screen_viewed", { screen: "welcome" });
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      setTyped(WORDS[0]);
      return;
    }
    const full = WORDS[wordIndex];
    const atFull = !deleting && typed === full;
    const atEmpty = deleting && typed === "";
    const delay = atFull
      ? HOLD_MS
      : atEmpty
        ? GAP_MS
        : deleting
          ? DELETE_MS
          : TYPE_MS;

    const timer = setTimeout(() => {
      if (atFull) {
        setDeleting(true);
      } else if (atEmpty) {
        setDeleting(false);
        setWordIndex((i) => (i + 1) % WORDS.length);
      } else {
        setTyped(full.slice(0, typed.length + (deleting ? -1 : 1)));
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [typed, deleting, wordIndex, reduceMotion]);

  useEffect(() => {
    if (reduceMotion) {
      breathe.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, {
          toValue: 1,
          duration: BREATHE_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(breathe, {
          toValue: 0,
          duration: BREATHE_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, breathe]);

  async function onGoogle() {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setGoogleBusy(true);
    setError(null);
    track("oauth_started", { provider: "google", mode: "sign_in" });
    try {
      await signInWithGoogle();
    } catch (e) {
      track("auth_failed", { step: "oauth_google" });
      setError(friendlyError(e, "Google sign-in failed"));
    } finally {
      requestInFlight.current = false;
      setGoogleBusy(false);
    }
  }

  async function onApple() {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setAppleBusy(true);
    setError(null);
    track("oauth_started", { provider: "apple", mode: "sign_in" });
    try {
      await signInWithApple();
    } catch (e) {
      track("auth_failed", { step: "oauth_apple" });
      setError(friendlyError(e, "Apple sign-in failed"));
    } finally {
      requestInFlight.current = false;
      setAppleBusy(false);
    }
  }

  async function onBrowser(provider: BrowserOAuthProvider) {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setBrowserBusy(provider);
    setError(null);
    track("oauth_started", { provider, mode: "sign_in" });
    try {
      if (provider === "github") await signInWithGitHub();
      else await signInWithSlack();
    } catch (failure) {
      setError(friendlyError(failure, "Sign-in failed. Please try again."));
    } finally {
      requestInFlight.current = false;
      setBrowserBusy(null);
    }
  }

  const headlineFit = { fontSize: headlineSize, lineHeight };
  const dotFit = { width: dotSize, height: dotSize, borderRadius: dotSize / 2 };
  const breatheStyle = {
    opacity: breathe.interpolate({
      inputRange: [0, 1],
      outputRange: [1, 0.65],
    }),
    transform: [
      {
        scale: breathe.interpolate({
          inputRange: [0, 1],
          outputRange: [1, 0.92],
        }),
      },
    ],
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {}
        <View style={styles.hero}>
          <Text style={[styles.headline, headlineFit]}>Let{"’"}s</Text>

          {}
          <View style={{ minHeight: lineHeight }}>
            <Text style={[styles.headline, headlineFit]}>
              {typed}
              {}
              <Animated.View style={[styles.dot, dotFit, breatheStyle]} />
            </Text>
          </View>

          <Text style={styles.sub}>
            Your ideas. A little direction.{"\n"}A lot less on your plate.
          </Text>
        </View>

        {}
        <View style={[styles.dock, { paddingBottom: 18 + insets.bottom }]}>
          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <BrowserSignInButton
            provider="github"
            busy={busy}
            active={browserBusy === "github"}
            onPress={onBrowser}
            dock
          />

          <Pressable
            style={[styles.btn, styles.btnGoogle, busy && styles.btnBusy]}
            onPress={onGoogle}
            disabled={busy}
            accessibilityRole="button"
          >
            <Image
              source={require("../../../assets/images/google-g.png")}
              style={styles.googleMark}
            />
            <Text
              style={[styles.btnText, styles.btnTextGoogle]}
              numberOfLines={1}
            >
              {googleBusy ? "Opening Google…" : "Continue with Google"}
            </Text>
          </Pressable>

          {}
          {appleAvailable ? (
            <Pressable
              style={[styles.btn, styles.btnGoogle, busy && styles.btnBusy]}
              onPress={onApple}
              disabled={busy}
              accessibilityRole="button"
            >
              <AppleMark size={20} color={dock.googleFg} />
              <Text
                style={[styles.btnText, styles.btnTextGoogle]}
                numberOfLines={1}
              >
                {appleBusy ? "Opening Apple…" : "Continue with Apple"}
              </Text>
            </Pressable>
          ) : null}

          <BrowserSignInButton
            provider="slack_oidc"
            busy={busy}
            active={browserBusy === "slack_oidc"}
            onPress={onBrowser}
            dock
          />

          {isEmailSignupEnabled(signupAvailability.data) ? (
            <Pressable
              style={[styles.btn, styles.btnEmail]}
              onPress={() => {
                track("signup_started");
                router.push("/(auth)/signup");
              }}
              disabled={busy}
              accessibilityRole="button"
            >
              <Text
                style={[styles.btnText, styles.btnTextOnDark]}
                numberOfLines={1}
              >
                Sign up with email
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[styles.btn, styles.btnLogin]}
            onPress={() => router.push("/(auth)/login")}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text
              style={[styles.btnText, styles.btnTextOnDark]}
              numberOfLines={1}
            >
              Log in
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Colors, dark: boolean) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { flexGrow: 1 },
  hero: {
    flexGrow: 1,
    flexShrink: 0,
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 20,
  },
  headline: {
    fontFamily: "Inter_700Bold",
    includeFontPadding: false,
    letterSpacing: -1.4,
    color: colors.ink,
  },
  dot: {
    marginLeft: 7,
    backgroundColor: colors.ink,
  },
  sub: {
    marginTop: 21,
    maxWidth: 275,
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: font.size.base,
    lineHeight: 21,
    color: colors.muted,
  },
  dock: {
    backgroundColor: dock.bg,
    borderTopLeftRadius: 34,
    borderTopRightRadius: 34,
    ...(dark ? { borderWidth: 1, borderBottomWidth: 0, borderColor: colors.borderRaised } : null),
    paddingTop: 34,
    paddingHorizontal: 16,
    gap: 10,
  },
  btn: {
    height: 51,
    borderRadius: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
    gap: 9,
  },
  btnBusy: { opacity: 0.6 },
  btnGoogle: { backgroundColor: "#fff" },
  btnEmail: { backgroundColor: dock.emailBg },
  btnLogin: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: dock.loginBorder,
  },
  btnText: { flexShrink: 1, includeFontPadding: false, fontFamily: "Inter_600SemiBold", fontSize: 15 },
  btnTextGoogle: { color: dock.googleFg },
  btnTextOnDark: { color: dock.onDark },
  googleMark: { width: 20, height: 20 },
  errorBox: {
    backgroundColor: dock.errorBg,
    borderWidth: 1,
    borderColor: dock.errorBorder,
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 4,
  },
  errorText: {
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: 13,
    lineHeight: 19,
    color: dock.errorFg,
    textAlign: "center",
  },
});
