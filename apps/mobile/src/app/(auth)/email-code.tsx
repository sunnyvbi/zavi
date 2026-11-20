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
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAuth } from "../../auth/AuthProvider";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { KeyboardAvoider } from "../../components/KeyboardAvoider";
import { ErrorCard, friendlyError } from "../../components/ErrorCard";
import { UnderlinedText } from "../../components/UnderlinedText";
import { useKeyboardOpen } from "../../components/useKeyboardReveal";
import { BackIcon } from "../../components/Icon";
import { track } from "../../lib/analytics";

const EMAIL_CODE_LENGTH = 8;
const RESEND_SECONDS = 30;
const BRAND_RATIO = 63 / 25.6639;
const BRAND_HEIGHT = 24;
const TITLE_SIZE = 27;
const BAD_CODE = /expired or is invalid|otp_expired/i;
const BAD_CODE_TEXT =
  "That code didn't work. It may be mistyped or expired. Use the newest email from Zavi, or tap Resend code.";

type Purpose = "signin" | "signup" | "unconfirmed";

export default function EmailCode() {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ email?: string; purpose?: string; earlier?: string }>();
  const earlier = params.earlier === "1";
  const email = params.email ?? "";
  const purpose: Purpose =
    params.purpose === "signup" || params.purpose === "unconfirmed" ? params.purpose : "signin";
  const confirming = purpose !== "signin";
  const { sendEmailCode, verifyEmailCode, resendSignupCode } = useAuth();

  const [code, setCode] = useState("");
  const [focused, setFocused] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(earlier ? 60 : RESEND_SECONDS);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const keyboardOpen = useKeyboardOpen();

  useEffect(() => {
    track("auth_screen_viewed", { screen: "verify_code" });
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function verify(value = code) {
    if (inFlight.current || value.length < EMAIL_CODE_LENGTH) return;
    inFlight.current = true;
    setVerifying(true);
    setError(null);
    setNotice(null);
    try {
      await verifyEmailCode(email, value, confirming ? "signup" : "email");
      Keyboard.dismiss();
    } catch (e) {
      track("auth_failed", { step: "email_code_verify" });
      const message = friendlyError(e, "Something went wrong. Please try again.");
      setError(BAD_CODE.test(message) ? BAD_CODE_TEXT : message);
      setVerifying(false);
    } finally {
      inFlight.current = false;
    }
  }

  async function resend() {
    if (cooldown > 0 || sending) return;
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      if (confirming) await resendSignupCode(email);
      else await sendEmailCode(email);
      setCode("");
      setCooldown(RESEND_SECONDS);
      setNotice("We sent a new code.");
    } catch (e) {
      track("auth_failed", { step: "email_code_send" });
      setError(friendlyError(e, "Something went wrong. Please try again."));
    } finally {
      setSending(false);
    }
  }

  function onChange(text: string) {
    const digits = text.replace(/\D/g, "").slice(0, EMAIL_CODE_LENGTH);
    setCode(digits);
    setError(null);
    if (digits.length === EMAIL_CODE_LENGTH) void verify(digits);
  }

  const ready = code.length === EMAIL_CODE_LENGTH;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <KeyboardAvoider style={styles.flex}>
        <View style={styles.nav}>
          <Pressable
            style={styles.back}
            onPress={() => {
              Keyboard.dismiss();
              if (router.canGoBack()) router.back();
              else router.replace("/(auth)/login");
            }}
            disabled={verifying}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <BackIcon />
          </Pressable>
        </View>

        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Image
            source={require("../../../assets/images/zavi-wordmark.png")}
            style={styles.brand}
            resizeMode="contain"
            accessibilityLabel="Zavi"
          />
          <Text style={styles.title}>
            {purpose === "unconfirmed" ? "Confirm your email first." : "Check your email."}
          </Text>
          {purpose === "signup" ? (
            <Text style={styles.sub}>
              {`We sent an ${EMAIL_CODE_LENGTH}-digit code to `}
              <Text style={styles.email}>{email}</Text>
              {`. Enter it to finish creating your account.`}
            </Text>
          ) : purpose === "unconfirmed" ? (
            <Text style={styles.sub}>
              <Text style={styles.email}>{email}</Text>
              {earlier
                ? ` was never confirmed. Enter the ${EMAIL_CODE_LENGTH}-digit code we emailed you a moment ago, or tap Resend code when it unlocks.`
                : ` was never confirmed. We just sent a new ${EMAIL_CODE_LENGTH}-digit code. Enter it to log in.`}
            </Text>
          ) : (
            <Text style={styles.sub}>
              {}
              {`If `}
              <Text style={styles.email}>{email}</Text>
              {` has a Zavi account, we sent ${/^(8|11|18)/.test(String(EMAIL_CODE_LENGTH)) ? "an" : "a"} ${EMAIL_CODE_LENGTH}-digit code to it. It expires soon.`}
            </Text>
          )}

          <Text style={styles.label}>Verification code</Text>
          <View style={styles.fieldWrap}>
            {focused ? <View style={styles.ring} pointerEvents="none" /> : null}
            <TextInput
              keyboardAppearance={keyboardAppearance}
              style={[styles.input, focused && styles.inputFocused]}
              value={code}
              onChangeText={onChange}
              keyboardType="number-pad"
              inputMode="numeric"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              maxLength={EMAIL_CODE_LENGTH + 4}
              cursorColor={colors.ink}
              selectionColor={textSelectionColor}
              selectionHandleColor={colors.ink}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              editable={!verifying}
              autoFocus
              accessibilityLabel={`${EMAIL_CODE_LENGTH}-digit verification code`}
            />
            {}
            {code ? null : (
              <View style={styles.dotsWrap} pointerEvents="none">
                <Text style={styles.dots}>{"•".repeat(EMAIL_CODE_LENGTH)}</Text>
              </View>
            )}
          </View>

          <View style={styles.hint}>
            <Text style={styles.hintText}>
              <Text style={styles.hintLead}>Can't find it?</Text>
              {" Check your spam or junk folder. It comes from support@zaviagent.com."}
            </Text>
          </View>

          {error ? (
            <ErrorCard message={error} />
          ) : null}
          {notice ? (
            <Text style={styles.notice} accessibilityLiveRegion="polite">
              {notice}
            </Text>
          ) : null}

          <Pressable
            style={styles.resend}
            onPress={() => void resend()}
            disabled={cooldown > 0 || sending || verifying}
            accessibilityRole="button"
            accessibilityState={{ disabled: cooldown > 0 || sending }}
          >
            {sending || cooldown > 0 ? (
              <Text style={[styles.resendText, styles.resendOff]}>
                {sending ? "Sending…" : `Resend code in ${cooldown}s`}
              </Text>
            ) : (
              <View style={styles.linkRow}>
                <Text style={[styles.resendText, styles.leadText]}>Didn't get it? </Text>
                <UnderlinedText style={[styles.resendText, styles.linkStrong]}>Resend code</UnderlinedText>
              </View>
            )}
          </Pressable>

          <Pressable
            style={styles.resend}
            onPress={() => {
              Keyboard.dismiss();
              if (purpose === "signup") router.dismissTo("/(auth)/signup");
              else if (purpose === "unconfirmed") router.dismissTo("/(auth)/login");
              else router.dismissTo({ pathname: "/(auth)/login", params: { mode: "password" } });
            }}
            disabled={verifying}
            accessibilityRole="button"
          >
            <UnderlinedText style={[styles.resendText, styles.linkStrong]}>
              {confirming ? "Use a different email" : "Use your password instead"}
            </UnderlinedText>
          </Pressable>
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: 8 + (keyboardOpen ? 0 : insets.bottom) }]}>
          <Pressable
            style={[styles.primary, (!ready || verifying) && styles.primaryOff]}
            onPress={() => void verify()}
            disabled={!ready || verifying}
            accessibilityRole="button"
            accessibilityState={{ disabled: !ready || verifying, busy: verifying }}
          >
            {verifying ? (
              <ActivityIndicator color={colors.onInk} />
            ) : (
              <Text style={styles.primaryText}>Continue</Text>
            )}
          </Pressable>
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
  body: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 20 },
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
  email: { fontFamily: "Inter_600SemiBold", color: colors.ink },
  label: {
    marginTop: 24,
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
    borderRadius: 18,
  },
  input: {
    height: 48,
    borderWidth: 1,
    borderColor: colors.form.edge,
    borderRadius: 15,
    backgroundColor: colors.bg,
    paddingHorizontal: 15,
    fontFamily: "Inter_600SemiBold",
    includeFontPadding: false,
    fontSize: 22,
    letterSpacing: 6,
    textAlign: "center",
    color: colors.ink,
  },
  inputFocused: { borderColor: colors.ink },
  dotsWrap: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center" },
  dots: {
    fontFamily: "Inter_600SemiBold",
    includeFontPadding: false,
    fontSize: 22,
    letterSpacing: 6,
    color: colors.form.placeholder,
  },
  hint: {
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: colors.form.panel,
  },
  hintText: {
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: 13,
    lineHeight: 18,
    color: colors.wire.body,
  },
  hintLead: { fontFamily: "Inter_700Bold", color: colors.ink },
  notice: {
    marginTop: 10,
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    color: colors.green,
    fontSize: font.size.sm,
    lineHeight: 17,
  },
  resend: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: 8 },
  resendText: {
    fontFamily: "Inter_500Medium",
    includeFontPadding: false,
    fontSize: font.size.sm,
    color: colors.ink,
  },
  resendOff: { color: colors.muted },
  linkRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", justifyContent: "center" },
  linkStrong: { fontFamily: "Inter_600SemiBold", color: colors.ink },
  leadText: { fontFamily: "Inter_400Regular", color: colors.muted },
  footer: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: colors.bg },
  primary: {
    height: 53,
    borderRadius: 30,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryOff: { opacity: 0.4 },
  primaryText: {
    fontFamily: "Inter_600SemiBold",
    includeFontPadding: false,
    fontSize: 15,
    color: colors.onInk,
  },
});
