import { useEffect, useRef, useState } from "react";
import { Keyboard, Linking, Platform, Text } from "react-native";
import { useRouter } from "expo-router";
import { sendPasswordReset } from "../../auth/forgotPassword";
import { validateEmail } from "../../auth/validateEmail";
import { friendlyError } from "../../components/ErrorCard";
import { useToast } from "../../components/Toast";
import {
  AuthError,
  AuthField,
  AuthLink,
  AuthNote,
  AuthShell,
  makeAuthStyles,
} from "../../components/auth/AuthShell";
import { useStyles } from "../../theme/theme";
import { track } from "../../lib/analytics";

const RESEND_COOLDOWN_MS = 60_000;

export default function ForgotPassword() {
  const authStyles = useStyles(makeAuthStyles);
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [cooling, setCooling] = useState(false);
  const inFlight = useRef(false);
  const cooldown = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { show, toast } = useToast({ top: 72 }, { fit: "content" });

  useEffect(() => {
    track("auth_screen_viewed", {
      screen: sentTo ? "reset_sent" : "forgot_password",
    });
  }, [sentTo]);

  useEffect(
    () => () => {
      if (cooldown.current) clearTimeout(cooldown.current);
    },
    [],
  );

  function toLogin() {
    if (router.canGoBack()) router.dismissTo("/(auth)/login");
    else router.replace("/(auth)/login");
  }

  async function send(address: string): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await sendPasswordReset(address);
      track("password_reset_requested");
      return true;
    } catch (e) {
      track("auth_failed", { step: "password_reset" });
      setError(friendlyError(e, "Could not send reset email. Try again."));
      return false;
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  async function onSubmit() {
    const address = email.trim().toLowerCase();
    const invalid = validateEmail(address);
    setEmailError(invalid);
    if (invalid) return;
    if (await send(address)) {
      Keyboard.dismiss();
      setSentTo(address);
    }
  }

  async function onResend() {
    if (!sentTo || cooling) return;
    if (!(await send(sentTo))) return;
    show("Sent again");
    setCooling(true);
    cooldown.current = setTimeout(() => setCooling(false), RESEND_COOLDOWN_MS);
  }

  if (sentTo) {
    return (
      <>
        <AuthShell
          onBack={() => setSentTo(null)}
          title="Check your email."
          sub={
            <>
              {"If there is a Zavi account for "}
              <Text style={authStyles.strong}>{sentTo}</Text>
              {", a reset link is on its way. Open it on this phone and the app opens."}
            </>
          }
          cta={Platform.OS === "ios" ? "Open Mail" : undefined}
          onCta={() => void Linking.openURL("message://").catch(() => {})}
        >
          {error ? <AuthError>{error}</AuthError> : null}
          <AuthLink
            lead="Nothing yet? "
            label={cooling ? "Sent. Try again in a minute" : "Send it again"}
            onPress={() => void onResend()}
            disabled={cooling || submitting}
          />
          <AuthLink label="Back to sign in" onPress={toLogin} />
        </AuthShell>
        {toast}
      </>
    );
  }

  return (
    <AuthShell
      onBack={toLogin}
      title="Reset your password."
      sub="Enter your email and we'll send you a link to set a new one."
      cta="Send reset link"
      onCta={() => void onSubmit()}
      busy={submitting}
    >
      <AuthField
        label="Email"
        placeholder="you@company.com"
        autoComplete="email"
        keyboardType="email-address"
        returnKeyType="send"
        value={email}
        onChangeText={(value) => {
          setEmail(value);
          setEmailError(null);
          setError(null);
        }}
        onSubmitEditing={() => void onSubmit()}
        editable={!submitting}
        autoFocus
        error={emailError}
      />
      {error ? <AuthError>{error}</AuthError> : null}
      <AuthNote>
        Signed up with Google, Apple, GitHub or Slack? You don&apos;t have a Zavi password. Go back and use that
        button.
      </AuthNote>
    </AuthShell>
  );
}
