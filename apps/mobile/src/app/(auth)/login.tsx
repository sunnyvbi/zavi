import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAuth } from "../../auth/AuthProvider";
import { validateEmail } from "../../auth/validateEmail";
import { isEmailSignupEnabled, useSignupAvailability } from "../../auth/signup";
import { BrowserSignInButton } from "../../components/BrowserSignInButton";
import type { BrowserOAuthProvider } from "../../auth/oauth";
import { AppleMark } from "../../components/AppleMark";
import { useAppleSignInAvailable } from "../../components/useAppleSignIn";
import { useKeyboardReveal } from "../../components/useKeyboardReveal";
import { ErrorCard, friendlyError } from "../../components/ErrorCard";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { KeyboardAvoider } from "../../components/KeyboardAvoider";
import { UnderlinedText } from "../../components/UnderlinedText";
import { PasswordEye } from "../../components/auth/PasswordEye";
import { hintText } from "../../components/ZaviTextField";
import { BackIcon } from "../../components/Icon";
import { track } from "../../lib/analytics";

const BRAND_RATIO = 63 / 25.6639;

const BRAND_HEIGHT = 24;
const TITLE_SIZE = 27;

export default function Login() {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const {
    signIn,
    resendSignupCode,
    sendEmailCode,
    signInWithGoogle,
    signInWithApple,
    signInWithGitHub,
    signInWithSlack,
  } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();
  const insets = useSafeAreaInsets();
  const signupAvailability = useSignupAvailability();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"password" | "code">("password");
  const [focused, setFocused] = useState<"email" | "password" | null>(null);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [appleBusy, setAppleBusy] = useState(false);
  const [codeBusy, setCodeBusy] = useState(false);
  const [browserBusy, setBrowserBusy] = useState<BrowserOAuthProvider | null>(
    null,
  );
  const appleAvailable = useAppleSignInAvailable();
  const passwordRef = useRef<TextInput>(null);
  const emailBox = useRef<View>(null);
  const passwordBox = useRef<View>(null);
  const { keyboardOpen, scrollRef, onScroll, reveal } = useKeyboardReveal();
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requestInFlight = useRef(false);

  useEffect(() => {
    track("auth_screen_viewed", { screen: "sign_in" });
  }, []);

  useEffect(() => {
    if (params.mode !== "password") return;
    setMode("password");
    router.setParams({ mode: undefined });
  }, [params.mode, router]);

  function switchMode(next: "password" | "code") {
    setMode(next);
    setPassword("");
    setPasswordVisible(false);
    setPasswordError(null);
    setError(null);
  }

  const busy = submitting || googleBusy || appleBusy || codeBusy || browserBusy !== null;

  async function onEmailCode() {
    if (requestInFlight.current) return;
    const address = email.trim();
    const invalidEmail = validateEmail(address);
    setEmailError(invalidEmail);
    setPasswordError(null);
    setError(null);
    if (invalidEmail) return;
    requestInFlight.current = true;
    setCodeBusy(true);
    track("login_submitted", { method: "email_code" });
    try {
      await sendEmailCode(address);
      Keyboard.dismiss();
      router.push({ pathname: "/(auth)/email-code", params: { email: address } });
    } catch (e) {
      track("auth_failed", { step: "email_code_send" });
      setError(friendlyError(e, "Couldn't send a code."));
    } finally {
      requestInFlight.current = false;
      setCodeBusy(false);
    }
  }

  async function onSubmit() {
    if (requestInFlight.current) return;
    const invalidEmail = validateEmail(email);
    const invalidPassword =
      password.length < 6 ? "Password must be at least 6 characters." : null;
    setEmailError(invalidEmail);
    setPasswordError(invalidPassword);
    setError(null);
    if (invalidEmail || invalidPassword) return;
    requestInFlight.current = true;
    setSubmitting(true);
    track("login_submitted", { method: "password" });
    try {
      await signIn(email.trim(), password);
    } catch (e) {
      track("auth_failed", { step: "password_login" });
      if ((e as { code?: string } | null)?.code === "email_not_confirmed") {
        const address = email.trim();
        let earlier = false;
        try {
          await resendSignupCode(address);
        } catch (sendErr) {
          const err = sendErr as { status?: number; code?: string; message?: string };
          earlier = /only request this after/i.test(err?.message ?? "");
          if (!earlier) {
            setError(friendlyError(sendErr, "Couldn't send a code. Try again in a moment."));
            requestInFlight.current = false;
            setSubmitting(false);
            return;
          }
        }
        requestInFlight.current = false;
        setSubmitting(false);
        Keyboard.dismiss();
        router.push({ pathname: "/(auth)/email-code", params: { email: address, purpose: "unconfirmed", ...(earlier ? { earlier: "1" } : {}) } });
        return;
      }
      setError(friendlyError(e, "Sign in failed"));
      requestInFlight.current = false;
      setSubmitting(false);
    }
  }

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
    Keyboard.dismiss();
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

  const continueButton = (
    <Pressable
      style={[styles.primary, busy && styles.busy]}
      onPress={mode === "code" ? () => void onEmailCode() : onSubmit}
      disabled={busy}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy, busy: submitting || codeBusy }}
    >
      {submitting || (mode === "code" && codeBusy) ? (
        <ActivityIndicator color={colors.onInk} />
      ) : (
        <Text style={styles.primaryText}>
          {mode === "code" ? "Send code" : "Continue"}
        </Text>
      )}
    </Pressable>
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <KeyboardAvoider style={styles.flex}>
        {}
        <View style={styles.nav}>
          <Pressable
            style={styles.back}
            onPress={() => {
              Keyboard.dismiss();
              if (router.canGoBack()) router.back();
              else router.replace("/(auth)/welcome");
            }}
            disabled={busy}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <BackIcon />
          </Pressable>
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          onScroll={onScroll}
          scrollEventThrottle={16}
        >
          <Pressable
            style={styles.flex}
            onPress={Keyboard.dismiss}
            accessible={false}
          >
            {}
            <Image
              source={require("../../../assets/images/zavi-wordmark.png")}
              style={styles.brand}
              resizeMode="contain"
              accessibilityLabel="Zavi"
            />
            <Text style={styles.title}>Welcome back.</Text>
            <Text style={styles.sub}>
              Use your email to open your workspace.
            </Text>

            {}
            <Text style={styles.label}>Email</Text>
            <View ref={emailBox} style={styles.fieldWrap}>
              {focused === "email" ? <View style={styles.ring} pointerEvents="none" /> : null}
              <TextInput
                keyboardAppearance={keyboardAppearance}
                style={[
                  styles.input,
                  focused === "email" && styles.inputFocused,
                ]}
                placeholder={hintText("you@company.com")}
                placeholderTextColor={colors.form.placeholder}
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                keyboardType="email-address"
                cursorColor={colors.ink}
                selectionColor={textSelectionColor}
            selectionHandleColor={colors.ink}
                returnKeyType={mode === "code" ? "send" : "next"}
                submitBehavior={mode === "code" ? "blurAndSubmit" : "submit"}
                onSubmitEditing={() => {
                  if (mode === "code") void onEmailCode();
                  else passwordRef.current?.focus();
                }}
                value={email}
                onChangeText={(value) => {
                  setEmail(value);
                  setEmailError(null);
                  setError(null);
                }}
                onFocus={() => {
                  setFocused("email");
                  reveal(emailBox.current);
                }}
                onBlur={() => setFocused(null)}
                editable={!busy}
                autoFocus
              />
            </View>
            {emailError ? <Text style={styles.error}>{emailError}</Text> : null}

            {}
            {mode === "password" ? (
            <>
            <Text style={styles.label}>Password</Text>
            <View ref={passwordBox} style={styles.fieldWrap}>
              {focused === "password" ? <View style={styles.ring} pointerEvents="none" /> : null}
              <TextInput
                keyboardAppearance={keyboardAppearance}
                ref={passwordRef}
                style={[
                  styles.input,
                  styles.inputWithToggle,
                  focused === "password" && styles.inputFocused,
                ]}
                placeholder={hintText("••••••••")}
                placeholderTextColor={colors.form.placeholder}
                secureTextEntry={!passwordVisible}
                autoCapitalize="none"
                autoComplete="password"
                cursorColor={colors.ink}
                selectionColor={textSelectionColor}
            selectionHandleColor={colors.ink}
                returnKeyType="done"
                value={password}
                onChangeText={(value) => {
                  setPassword(value);
                  setPasswordError(null);
                  setError(null);
                }}
                onFocus={() => {
                  setFocused("password");
                  reveal(passwordBox.current);
                }}
                onBlur={() => setFocused(null)}
                editable={!busy}
                onSubmitEditing={onSubmit}
              />

              {}
              <Pressable
                style={styles.toggle}
                onPress={() => setPasswordVisible((shown) => !shown)}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={
                  passwordVisible ? "Hide password" : "Show password"
                }
              >
                <PasswordEye visible={passwordVisible} empty={password.length === 0} />
              </Pressable>
            </View>
            {passwordError ? (
              <Text style={styles.error}>{passwordError}</Text>
            ) : null}

            <Pressable
              style={styles.forgotPassword}
              onPress={() => {
                Keyboard.dismiss();
                router.push("/(auth)/forgot-password");
              }}
              disabled={busy}
              accessibilityRole="button"
            >
              <UnderlinedText style={[styles.signupText, styles.linkStrong]}>
                Forgot password?
              </UnderlinedText>
            </Pressable>
            </>
            ) : null}

            {error ? <ErrorCard message={error} /> : null}

            <Pressable
              style={[styles.secondary, busy && styles.busy]}
              onPress={() => switchMode(mode === "code" ? "password" : "code")}
              disabled={busy}
              accessibilityRole="button"
              accessibilityHint={
                mode === "code"
                  ? "Shows the password field again"
                  : "Hides the password field so you can sign in with an emailed code"
              }
            >
              <Text style={styles.secondaryText}>
                {mode === "code"
                  ? "Use your password instead"
                  : "Send me a code via email instead"}
              </Text>
            </Pressable>

            {}
            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>OR</Text>
              <View style={styles.dividerLine} />
            </View>

            <BrowserSignInButton
              provider="github"
              busy={busy}
              active={browserBusy === "github"}
              onPress={onBrowser}
            />

            <Pressable
              style={[styles.secondary, busy && styles.busy]}
              onPress={onGoogle}
              disabled={busy}
              accessibilityRole="button"
            >
              <Image
                source={require("../../../assets/images/google-g.png")}
                style={styles.googleMark}
              />
              <Text style={styles.secondaryText}>
                {googleBusy ? "Opening Google…" : "Continue with Google"}
              </Text>
            </Pressable>

            {}
            {appleAvailable ? (
              <Pressable
                style={[styles.secondary, busy && styles.busy]}
                onPress={onApple}
                disabled={busy}
                accessibilityRole="button"
              >
                <AppleMark size={20} color={colors.ink} />
                <Text style={styles.secondaryText}>
                  {appleBusy ? "Opening Apple…" : "Continue with Apple"}
                </Text>
              </Pressable>
            ) : null}

            <BrowserSignInButton
              provider="slack_oidc"
              busy={busy}
              active={browserBusy === "slack_oidc"}
              onPress={onBrowser}
            />

            {isEmailSignupEnabled(signupAvailability.data) ? (
              <Pressable
                style={styles.signupLink}
                onPress={() => {
                  track("signup_started");
                  Keyboard.dismiss();
                  router.replace("/(auth)/signup");
                }}
                disabled={busy}
                accessibilityRole="button"
              >
                <View style={styles.linkRow}>
                  <Text style={[styles.signupText, styles.leadText]}>New here? </Text>
                  <UnderlinedText style={[styles.signupText, styles.linkStrong]}>Sign up</UnderlinedText>
                </View>
              </Pressable>
            ) : null}
          </Pressable>
        </ScrollView>

        {}
        <View style={[styles.footer, { paddingBottom: 8 + (keyboardOpen ? 0 : insets.bottom) }]}>
          {continueButton}
        </View>
      </KeyboardAvoider>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Colors, dark: boolean) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  nav: { height: 57, justifyContent: "center", paddingHorizontal: 16 },
  back: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.form.panel,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { paddingHorizontal: 16, paddingVertical: 20 },
  brand: {
    alignSelf: "center",
    width: Math.round(BRAND_HEIGHT * BRAND_RATIO),
    height: BRAND_HEIGHT,
    marginTop: 8,
    marginBottom: 24,
    ...(dark ? { tintColor: colors.ink } : null),
  },
  title: {
    textAlign: "center",
    fontFamily: "Inter_700Bold",
    includeFontPadding: false,
    fontSize: TITLE_SIZE,
    lineHeight: Math.round(TITLE_SIZE * 1.12),
    letterSpacing: -1.2,
    color: colors.ink,
    marginBottom: 13,
  },
  sub: {
    textAlign: "center",
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: font.size.base,
    lineHeight: 21,
    color: colors.muted,
  },
  label: {
    marginTop: 20,
    marginBottom: 6,
    fontFamily: font.family.medium,
    includeFontPadding: false,
    fontSize: 14,
    color: colors.ink,
  },
  fieldWrap: { position: "relative" },
  ring: {
    position: "absolute",
    top: -3,
    left: -3,
    right: -3,
    bottom: -3,
    borderWidth: 6,
    borderColor: colors.form.ring,
    borderRadius: 15,
  },
  input: {
    height: 48,
    borderWidth: 1,
    borderColor: colors.form.edge,
    borderRadius: 12,
    backgroundColor: colors.bg,
    paddingHorizontal: 12,
    fontFamily: font.family.medium,
    includeFontPadding: false,
    fontSize: 15,
    letterSpacing: 0,
    color: colors.ink,
  },
  inputFocused: { borderColor: colors.field.borderActive },
  inputWithToggle: { paddingRight: 40 },
  toggle: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  error: {
    marginTop: 10,
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    color: colors.red,
    fontSize: font.size.sm,
    lineHeight: 17,
  },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginVertical: 22,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.form.edge },
  dividerText: {
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: font.size.xs,
    color: colors.muted,
  },
  secondary: {
    marginTop: 10,
    height: 53,
    borderRadius: 30,
    borderWidth: 1,
    borderColor: colors.form.edge,
    backgroundColor: colors.bg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
  },
  secondaryText: {
    fontFamily: "Inter_600SemiBold",
    includeFontPadding: false,
    fontSize: 15,
    color: colors.ink,
  },
  googleMark: { width: 20, height: 20 },
  busy: { opacity: 0.6 },
  forgotPassword: {
    minHeight: 32,
    alignItems: "flex-end",
    justifyContent: "center",
    marginTop: 8,
  },
  signupLink: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 16,
  },
  signupText: {
    fontFamily: "Inter_500Medium",
    includeFontPadding: false,
    fontSize: font.size.sm,
    color: colors.ink,
  },
  linkRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", justifyContent: "center" },
  linkStrong: { fontFamily: "Inter_600SemiBold", color: colors.ink },
  leadText: { includeFontPadding: false, fontFamily: "Inter_400Regular", color: colors.muted },
  footer: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: colors.bg },
  primary: {
    height: 53,
    borderRadius: 30,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: {
    fontFamily: "Inter_600SemiBold",
    includeFontPadding: false,
    fontSize: 15,
    color: colors.onInk,
  },
});
