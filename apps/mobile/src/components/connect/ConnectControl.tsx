import { useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { connectInfoFor, type ConnectInfo } from "@zavi/shared";
import { openConnectInBrowser, startComposio, startOAuth } from "../../features/connectors/api";
import { planConnect } from "../../features/connectors/connectPlan";
import { CardButton, errorText } from "../reply/ui";
import { ErrorCard } from "../ErrorCard";
import { showDialog } from "../DialogHost";
import { KeyForm } from "./KeyForms";
import { track } from "../../lib/analytics";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const COMPOSIO_CONNECT_LINE = "You'll approve access through Composio, our secure connection partner.";

function confirmComposio(): Promise<boolean> {
  return showDialog({
    icon: "shieldCheck",
    title: "Connect",
    message: COMPOSIO_CONNECT_LINE,
    cancelLabel: "Cancel",
    confirmLabel: "Continue",
  });
}

export function ConnectControl({
  slug,
  label,
  mode = "connect",
  variant = "primary",
  fallback,
  block = false,
  buttonLabel,
  onAttempted,
}: {
  slug: string;
  label?: string;
  mode?: "connect" | "reconnect";
  variant?: "primary" | "secondary";
  fallback?: ConnectInfo;
  block?: boolean;
  buttonLabel?: string;
  onAttempted: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const info = connectInfoFor(slug, label) ?? fallback ?? null;
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!info) return null;
  const plan = planConnect(slug, info);
  const verb = mode === "reconnect" ? "Reconnect" : "Connect";
  const text = buttonLabel ?? (block ? verb : `${verb} ${info.label}`);
  const primary = variant === "primary";

  async function go() {
    setError(null);
    if (plan.kind === "form") {
      setFormOpen((v) => !v);
      return;
    }
    if (plan.kind === "web") {
      await Linking.openURL(plan.url).catch(() => setError("Couldn't open zaviagent.com."));
      return;
    }
    if (plan.kind === "composio" && !(await confirmComposio())) return;
    track("connector_connect_started", { slug, method: "oauth" });
    setBusy(true);
    try {
      const url = plan.kind === "oauth" ? await startOAuth(plan.path) : await startComposio(plan.toolkit);
      await openConnectInBrowser(url);
      onAttempted();
    } catch (e) {
      track("connector_connect_failed", { slug });
      setError(`Couldn't open the connection: ${errorText(e, "please try again.")}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 8 }}>
      {formOpen && plan.kind === "form" ? (
        <KeyForm
          slug={slug}
          form={plan.form}
          onCancel={() => setFormOpen(false)}
          onConnected={() => {
            setFormOpen(false);
            onAttempted();
          }}
        />
      ) : block ? (
        <Pressable
          style={({ pressed }) => [
            styles.button,
            primary ? styles.primary : styles.secondary,
            (busy || pressed) && styles.dim,
          ]}
          onPress={() => void go()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityState={{ busy }}
        >
          {busy ? <ActivityIndicator color={primary ? colors.onInk : colors.wire.strong} size="small" /> : null}
          <Text style={[styles.text, primary ? styles.primaryText : styles.secondaryText]} numberOfLines={1}>
            {busy ? "Opening" : text}
          </Text>
        </Pressable>
      ) : (
        <View style={{ flexDirection: "row" }}>
          <CardButton label={busy ? "Opening" : text} busy={busy} variant={variant} onPress={() => void go()} />
        </View>
      )}
      {error ? <ErrorCard message={error} style={styles.error} /> : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  button: {
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
    borderRadius: 999,
  },
  primary: {
    backgroundColor: colors.wire.ink,
  },
  secondary: {
    borderWidth: 1,
    borderColor: colors.wire.line,
    backgroundColor: colors.panel,
  },
  dim: { opacity: 0.55 },
  error: { marginTop: 0 },
  text: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 14 },
  primaryText: { color: colors.onInk },
  secondaryText: { color: colors.wire.strong },
});
