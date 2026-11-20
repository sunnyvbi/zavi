import { useEffect, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { supabase } from "../lib/supabase";
import { resetTo } from "../lib/nav";
import { setFlash } from "../lib/flash";
import { friendlyError } from "../components/ErrorCard";
import { AuthError, AuthField, AuthLink, AuthShell, AuthWaiting } from "../components/auth/AuthShell";
import { track } from "../lib/analytics";

type Phase = "verifying" | "form" | "expired";

const MIN_LENGTH = 8;

function passwordError(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  if (code === "weak_password") {
    return "That password is too easy to guess. Try a longer one, or add a few words.";
  }
  if (code === "same_password") return "That's your current password. Pick a new one.";
  return friendlyError(e, "Couldn't save your new password. Try again.");
}

export default function ResetPassword() {
  const router = useRouter();
  const { token_hash: tokenHash } = useLocalSearchParams<{ token_hash?: string }>();
  const [phase, setPhase] = useState<Phase>(tokenHash ? "verifying" : "expired");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const verified = useRef<string | null>(null);

  useEffect(() => {
    if (!tokenHash || verified.current === tokenHash) return;
    verified.current = tokenHash;
    setPhase("verifying");
    supabase.auth
      .verifyOtp({ token_hash: tokenHash, type: "recovery" })
      .then(({ data, error: e }) => setPhase(e || !data.session ? "expired" : "form"))
      .catch(() => setPhase("expired"));
  }, [tokenHash]);

  async function onSave() {
    if (password.length < MIN_LENGTH) return setError("Password must be at least 8 characters.");
    if (password !== confirm) return setError("Passwords don't match.");
    setError(null);
    setSaving(true);
    try {
      const { error: e } = await supabase.auth.updateUser({ password });
      if (e) throw e;
      track("password_reset_completed");
      setFlash("Password updated. You're signed in.");
      resetTo("/");
    } catch (e) {
      track("auth_failed", { step: "password_reset" });
      setError(passwordError(e));
    } finally {
      setSaving(false);
    }
  }

  if (phase === "verifying") return <AuthWaiting label="Checking your link…" />;

  if (phase === "expired") {
    return (
      <AuthShell
        onBack={() => resetTo("/")}
        title="This link has expired"
        sub="Reset links work once and only for a short time. Ask for a new one and use the newest email."
        cta="Send a new link"
        onCta={() => router.replace("/(auth)/forgot-password")}
      >
        <AuthLink label="Back to sign in" onPress={() => resetTo("/(auth)/login")} />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      onBack={() => resetTo("/")}
      title="Set a new password."
      sub="Pick something at least 8 characters long. You'll be signed straight in."
      cta="Save new password"
      onCta={() => void onSave()}
      busy={saving}
      ctaDisabled={!password || !confirm}
    >
      <AuthField
        label="New password"
        placeholder="At least 8 characters"
        secure
        autoComplete="new-password"
        textContentType="newPassword"
        value={password}
        onChangeText={(v) => {
          setPassword(v);
          setError(null);
        }}
        editable={!saving}
        autoFocus
      />
      <AuthField
        label="Confirm new password"
        placeholder="Type it again"
        secure
        autoComplete="new-password"
        textContentType="newPassword"
        returnKeyType="done"
        value={confirm}
        onChangeText={(v) => {
          setConfirm(v);
          setError(null);
        }}
        onSubmitEditing={() => void onSave()}
        editable={!saving}
      />
      {error ? <AuthError>{error}</AuthError> : null}
    </AuthShell>
  );
}
