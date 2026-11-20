import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Keyboard,
  Linking,
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
import { useRouter } from "expo-router";
import { useAuth } from "../../auth/AuthProvider";
import { validateEmail } from "../../auth/validateEmail";
import { isEmailSignupEnabled, useSignupAvailability } from "../../auth/signup";
import { BrowserSignInButton } from "../../components/BrowserSignInButton";
import type { BrowserOAuthProvider } from "../../auth/oauth";
import { AppleMark } from "../../components/AppleMark";
import { useAppleSignInAvailable } from "../../components/useAppleSignIn";
import { useKeyboardReveal } from "../../components/useKeyboardReveal";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { KeyboardAvoider } from "../../components/KeyboardAvoider";
import { ErrorCard, friendlyError } from "../../components/ErrorCard";
import { UnderlinedText } from "../../components/UnderlinedText";
import { PasswordEye } from "../../components/auth/PasswordEye";
import { hintText } from "../../components/ZaviTextField";
import { BackIcon } from "../../components/Icon";
import { track } from "../../lib/analytics";

export default function Signup() {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const {
    signUp,
    signInWithGoogle,
    signInWithApple,
    signInWithGitHub,
    signInWithSlack,
  } = useAuth();
  const availability = useSignupAvailability();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [focused, setFocused] = useState<
    "firstName" | "lastName" | "email" | "password" | null
  >(null);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [appleBusy, setAppleBusy] = useState(false);
  const [browserBusy, setBrowserBusy] = useState<BrowserOAuthProvider | null>(
    null,
  );
  const appleAvailable = useAppleSignInAvailable();
  const [firstNameError, setFirstNameError] = useState<string | null>(null);
  const [lastNameError, setLastNameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastNameRef = useRef<TextInput>(null);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const requestInFlight = useRef(false);
  const firstNameBox = useRef<View>(null);
  const lastNameBox = useRef<View>(null);
  const emailBox = useRef<View>(null);
  const passwordBox = useRef<View>(null);
  const { keyboardOpen, scrollRef, onScroll, reveal } = useKeyboardReveal();

  const busy = submitting || googleBusy || appleBusy || browserBusy !== null;
  const signupClosed =
    availability.isSuccess && !isEmailSignupEnabled(availability.data);

  useEffect(() => {
    track("auth_screen_viewed", { screen: "sign_up" });
  }, []);

  async function checkAvailability(): Promise<boolean> {
    const result = await availability.refetch();
    if (!result.isSuccess) {
      setError("Unable to check signup availability. Please try again.");
      return false;
    }
    if (!isEmailSignupEnabled(result.data)) {
      setError(
        "Signup is currently unavailable. You can still log in to an existing account.",
      );
      return false;
    }
    return true;
  }

  async function onSubmit() {
    if (requestInFlight.current) return;
    const invalidFirstName = !firstName.trim()
      ? "First name is required."
      : null;
    const invalidLastName = !lastName.trim() ? "Last name is required." : null;
    const invalidEmail = validateEmail(email);
    const invalidPassword = !password
      ? "Password is required."
      : password.length < 8
        ? "Password must be at least 8 characters."
        : null;
    setFirstNameError(invalidFirstName);
    setLastNameError(invalidLastName);
    setEmailError(invalidEmail);
    setPasswordError(invalidPassword);
    setError(null);
    if (invalidFirstName || invalidLastName || invalidEmail || invalidPassword)
      return;

    requestInFlight.current = true;
    setSubmitting(true);
    let awaitingSessionRedirect = false;
    track("signup_submitted", { method: "password" });
    try {
      if (!(await checkAvailability())) return;
      const result = await signUp(email.trim(), password, firstName, lastName);
      if (result.alreadyRegistered) {
        setError("You already have an account with this email. Log in instead.");
      } else if (result.needsConfirmation) {
        Keyboard.dismiss();
        router.push({
          pathname: "/(auth)/email-code",
          params: { email: email.trim(), purpose: "signup" },
        });
      } else {
        awaitingSessionRedirect = true;
      }
    } catch (e) {
      track("auth_failed", { step: "signup" });
      setError(friendlyError(e, "Signup failed. Please try again."));
    } finally {
      if (!awaitingSessionRedirect) {
        requestInFlight.current = false;
        setSubmitting(false);
      }
    }
  }

  async function onGoogle() {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setGoogleBusy(true);
    setError(null);
    track("oauth_started", { provider: "google", mode: "sign_up" });
    try {
      if (await checkAvailability()) await signInWithGoogle();
    } catch (e) {
      track("auth_failed", { step: "oauth_google" });
      setError(friendlyError(e, "Google sign-in failed. Please try again."));
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
    track("oauth_started", { provider: "apple", mode: "sign_up" });
    try {
      if (await checkAvailability()) await signInWithApple();
    } catch (e) {
      track("auth_failed", { step: "oauth_apple" });
      setError(friendlyError(e, "Apple sign-in failed. Please try again."));
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
    track("oauth_started", { provider, mode: "sign_up" });
    try {
      if (!(await checkAvailability())) return;
      if (provider === "github") await signInWithGitHub();
      else await signInWithSlack();
    } catch (failure) {
      setError(friendlyError(failure, "Sign-in failed. Please try again."));
    } finally {
      requestInFlight.current = false;
      setBrowserBusy(null);
    }
  }

  function openPolicy(path: "/terms" | "/privacy") {
    void Linking.openURL(`https://www.zaviagent.com${path}`).catch(() => {
      setError("Unable to open this page. Please try again.");
    });
  }

  const continueButton = (
    <Pressable
      style={[styles.primary, busy && styles.busy]}
      onPress={onSubmit}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel="Create account"
      accessibilityState={{ busy }}
    >
      {submitting ? (
        <ActivityIndicator color={colors.onInk} />
      ) : (
        <Text style={styles.primaryText}>Create account</Text>
      )}
    </Pressable>
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <KeyboardAvoider style={styles.flex}>
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
            <Image
              source={require("../../../assets/images/zavi-wordmark.png")}
              style={styles.brand}
              resizeMode="contain"
              accessibilityLabel="Zavi"
            />
            <Text style={styles.title}>
              Create your account.
            </Text>
            <Text style={styles.sub}>
              Use your email to get started with Zavi.
            </Text>

            {signupClosed ? (
              <Text style={styles.notice} accessibilityLiveRegion="polite">
                Signup is currently unavailable. You can still log in to an
                existing account.
              </Text>
            ) : (
              <>
                <View style={styles.nameRow}>
                  <View ref={firstNameBox} style={styles.nameColumn}>
                    <Text style={styles.label}>First name</Text>
                    <View style={styles.fieldWrap}>
                      {focused === "firstName" ? (
                        <View style={styles.ring} pointerEvents="none" />
                      ) : null}
                      <TextInput
                        keyboardAppearance={keyboardAppearance}
                        style={[
                          styles.input,
                          focused === "firstName" && styles.inputFocused,
                        ]}
                        placeholder={hintText("First name")}
                        placeholderTextColor={colors.form.placeholder}
                        accessibilityLabel="First name"
                        autoCapitalize="words"
                        autoComplete="given-name"
                        autoCorrect={false}
                        cursorColor={colors.ink}
                        selectionColor={textSelectionColor}
            selectionHandleColor={colors.ink}
                        returnKeyType="next"
                        submitBehavior="submit"
                        onSubmitEditing={() => lastNameRef.current?.focus()}
                        value={firstName}
                        onChangeText={(value) => {
                          setFirstName(value);
                          setFirstNameError(null);
                          setError(null);
                        }}
                        onFocus={() => {
                          setFocused("firstName");
                          reveal(firstNameBox.current);
                        }}
                        onBlur={() => setFocused(null)}
                        editable={!busy}
                        autoFocus
                      />
                    </View>
                    {firstNameError ? (
                      <Text style={styles.error}>{firstNameError}</Text>
                    ) : null}
                  </View>
                  <View ref={lastNameBox} style={styles.nameColumn}>
                    <Text style={styles.label}>Last name</Text>
                    <View style={styles.fieldWrap}>
                      {focused === "lastName" ? (
                        <View style={styles.ring} pointerEvents="none" />
                      ) : null}
                      <TextInput
                        keyboardAppearance={keyboardAppearance}
                        ref={lastNameRef}
                        style={[
                          styles.input,
                          focused === "lastName" && styles.inputFocused,
                        ]}
                        placeholder={hintText("Last name")}
                        placeholderTextColor={colors.form.placeholder}
                        accessibilityLabel="Last name"
                        autoCapitalize="words"
                        autoComplete="family-name"
                        autoCorrect={false}
                        cursorColor={colors.ink}
                        selectionColor={textSelectionColor}
            selectionHandleColor={colors.ink}
                        returnKeyType="next"
                        submitBehavior="submit"
                        onSubmitEditing={() => emailRef.current?.focus()}
                        value={lastName}
                        onChangeText={(value) => {
                          setLastName(value);
                          setLastNameError(null);
                          setError(null);
                        }}
                        onFocus={() => {
                          setFocused("lastName");
                          reveal(lastNameBox.current);
                        }}
                        onBlur={() => setFocused(null)}
                        editable={!busy}
                      />
                    </View>
                    {lastNameError ? (
                      <Text style={styles.error}>{lastNameError}</Text>
                    ) : null}
                  </View>
                </View>

                <Text style={styles.label}>Email</Text>
                <View ref={emailBox} style={styles.fieldWrap}>
                  {focused === "email" ? (
                    <View style={styles.ring} pointerEvents="none" />
                  ) : null}
                  <TextInput
                    keyboardAppearance={keyboardAppearance}
                    ref={emailRef}
                    style={[
                      styles.input,
                      focused === "email" && styles.inputFocused,
                    ]}
                    placeholder={hintText("you@company.com")}
                    placeholderTextColor={colors.form.placeholder}
                    accessibilityLabel="Email"
                    autoCapitalize="none"
                    autoComplete="email"
                    autoCorrect={false}
                    keyboardType="email-address"
                    cursorColor={colors.ink}
                    selectionColor={textSelectionColor}
            selectionHandleColor={colors.ink}
                    returnKeyType="next"
                    submitBehavior="submit"
                    onSubmitEditing={() => passwordRef.current?.focus()}
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
                  />
                </View>
                {emailError ? (
                  <Text style={styles.error}>{emailError}</Text>
                ) : null}

                <Text style={styles.label}>Password</Text>
                <View ref={passwordBox} style={styles.fieldWrap}>
                  {focused === "password" ? (
                    <View style={styles.ring} pointerEvents="none" />
                  ) : null}
                  <TextInput
                    keyboardAppearance={keyboardAppearance}
                    ref={passwordRef}
                    style={[
                      styles.input,
                      styles.inputWithToggle,
                      focused === "password" && styles.inputFocused,
                    ]}
                    placeholder={hintText("At least 8 characters")}
                    placeholderTextColor={colors.form.placeholder}
                    accessibilityLabel="Password"
                    secureTextEntry={!passwordVisible}
                    autoCapitalize="none"
                    autoComplete="new-password"
                    autoCorrect={false}
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
                  <Pressable
                    style={styles.toggle}
                    onPress={() => setPasswordVisible((shown) => !shown)}
                    disabled={busy}
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

                {error || availability.isError ? (
                  <ErrorCard
                    message={
                      error ||
                      "Unable to check signup availability. Try creating your account again to retry."
                    }
                  />
                ) : null}

                <View style={[styles.linkRow, styles.terms]}>
                  <Text style={styles.termsText}>By continuing you agree to our </Text>
                  <Pressable onPress={() => openPolicy("/terms")} hitSlop={6} accessibilityRole="link">
                    <UnderlinedText style={[styles.termsText, styles.linkStrong]}>terms</UnderlinedText>
                  </Pressable>
                  <Text style={styles.termsText}> and </Text>
                  <Pressable onPress={() => openPolicy("/privacy")} hitSlop={6} accessibilityRole="link">
                    <UnderlinedText style={[styles.termsText, styles.linkStrong]}>privacy policy</UnderlinedText>
                  </Pressable>
                  <Text style={styles.termsText}>.</Text>
                </View>

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
              </>
            )}

            <Pressable
              style={styles.loginLink}
              onPress={() => {
                Keyboard.dismiss();
                router.replace("/(auth)/login");
              }}
              disabled={busy}
              accessibilityRole="button"
            >
              <View style={styles.linkRow}>
                {!signupClosed ? (
                  <Text style={[styles.loginText, styles.leadText]}>Already have an account? </Text>
                ) : null}
                <UnderlinedText style={[styles.loginText, styles.linkStrong]}>Log in</UnderlinedText>
              </View>
            </Pressable>
          </Pressable>
        </ScrollView>

        {signupClosed ? null : (
          <View style={[styles.footer, { paddingBottom: 8 + (keyboardOpen ? 0 : insets.bottom) }]}>
            {continueButton}
          </View>
        )}
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
    width: Math.round(24 * (63 / 25.6639)),
    height: 24,
    marginTop: 8,
    marginBottom: 24,
    ...(dark ? { tintColor: colors.ink } : null),
  },
  title: {
    textAlign: "center",
    fontFamily: "Inter_700Bold",
    includeFontPadding: false,
    fontSize: 27,
    lineHeight: 30,
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
  nameRow: { flexDirection: "row", gap: 12 },
  nameColumn: { flex: 1, minWidth: 0 },
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
    lineHeight: 18,
  },
  notice: {
    marginTop: 24,
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    color: colors.muted,
    fontSize: font.size.base,
    lineHeight: 22,
  },
  terms: { marginTop: 20, justifyContent: "flex-start" },
  termsText: {
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: font.size.xs,
    lineHeight: 18,
    color: colors.muted,
  },
  linkRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", justifyContent: "center" },
  linkStrong: { fontFamily: "Inter_600SemiBold", color: colors.ink },
  leadText: { includeFontPadding: false, fontFamily: "Inter_400Regular", color: colors.muted },
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
  loginLink: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 16,
  },
  loginText: {
    fontFamily: "Inter_500Medium",
    includeFontPadding: false,
    fontSize: font.size.sm,
    color: colors.ink,
  },
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
